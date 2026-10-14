# D3D11 bench via ctypes: D3DCompile time, CreatePixelShader time, GPU cost of a fullscreen pass.
import ctypes as C, sys, time, struct
from ctypes import wintypes as W

d3dc = C.WinDLL("d3dcompiler_47.dll")
d3d11 = C.WinDLL("d3d11.dll")
HR = C.c_long
P = C.c_void_p

def vcall(obj, idx, restype, *args):
    vt = C.cast(C.cast(obj, C.POINTER(P))[0], C.POINTER(P))
    argtypes = [P] + [C.c_uint if isinstance(a, int) else (P if type(a).__name__ == "CArgObject" else type(a)) for a in args]
    fn = C.WINFUNCTYPE(restype, *argtypes)(vt[idx])
    return fn(obj, *args)

def check(hr, what):
    if hr != 0 and hr != 1:
        raise RuntimeError(f"{what} failed hr=0x{hr & 0xffffffff:08x}")

d3dc.D3DCompile.restype = HR
d3dc.D3DCompile.argtypes = [P, C.c_size_t, C.c_char_p, P, P, C.c_char_p, C.c_char_p, C.c_uint, C.c_uint, C.POINTER(P), C.POINTER(P)]

def blob_bytes(b):
    ptr = vcall(b, 3, P)
    n = vcall(b, 4, C.c_size_t)
    return C.string_at(ptr, n)

def compile_hlsl(src: bytes, entry: str, target: str, defines=None):
    code, err = P(), P()
    t = time.perf_counter()
    macros = None
    if defines:
        class M(C.Structure):
            _fields_ = [("n", C.c_char_p), ("d", C.c_char_p)]
        arr = (M * (len(defines) + 1))(*[M(k.encode(), v.encode()) for k, v in defines], M(None, None))
        macros = C.cast(arr, P)
    hr = d3dc.D3DCompile(src, len(src), b"fx", macros, None, entry.encode(), target.encode(), 1 << 15, 0, C.byref(code), C.byref(err))
    dt = (time.perf_counter() - t) * 1000
    if hr != 0:
        raise RuntimeError(blob_bytes(err).decode(errors="replace")[:800])
    return blob_bytes(code), dt

if len(sys.argv) > 1 and sys.argv[1] == "uber":
    src = open(sys.argv[2], "rb").read()
    for entry, defs in [("ps_main", None), ("ps_main", [("LAYER_MODELS", "1")]), ("vs_main", None)]:
        _, dt = compile_hlsl(src, entry, "ps_5_0" if entry.startswith("ps") else "vs_5_0", defs)
        print(f"uber {entry}{' +MODELS' if defs else ''}: D3DCompile {dt:.0f} ms")
    sys.exit()

src = open(sys.argv[1], "rb").read()
for i in range(3):
    ps_code, dt_ps = compile_hlsl(src, "fs_main", "ps_5_0")
    print(f"effect D3DCompile ps_5_0 O3: {dt_ps:.1f} ms")
vs_code, _ = compile_hlsl(src, "vs_main", "vs_5_0")
copy_src = b"""
Texture2D<float4> frame : register(t0); SamplerState samp : register(s1);
struct V { float4 pos : SV_Position; float2 uv : LOC0; };
V vs_main(uint i : SV_VertexID) { float2 p = float2((i << 1) & 2, i & 2); V o; o.pos = float4(p * 2 - 1, 0, 1); o.uv = float2(p.x, 1 - p.y); return o; }
float4 fs_main(V v) : SV_Target0 { return frame.SampleLevel(samp, v.uv, 0); }
"""
copy_ps, dt_copy = compile_hlsl(copy_src, "fs_main", "ps_5_0")
print(f"passthrough D3DCompile: {dt_copy:.1f} ms")

# Device
dev, ctx, fl = P(), P(), C.c_uint()
check(d3d11.D3D11CreateDevice(None, 1, None, 0, None, 0, 7, C.byref(dev), C.byref(fl), C.byref(ctx)), "D3D11CreateDevice")

def create_ps(code):
    ps = P()
    t = time.perf_counter()
    check(vcall(dev, 15, HR, C.c_char_p(code), C.c_size_t(len(code)), P(), C.byref(ps)), "CreatePixelShader")
    return ps, (time.perf_counter() - t) * 1000

vs = P()
check(vcall(dev, 12, HR, C.c_char_p(vs_code), C.c_size_t(len(vs_code)), P(), C.byref(vs)), "CreateVertexShader")
ps_fx, dt_create = create_ps(ps_code)
print(f"effect CreatePixelShader (driver): {dt_create:.2f} ms")
ps_copy, _ = create_ps(copy_ps)

class TEXDESC(C.Structure):
    _fields_ = [("W", C.c_uint), ("H", C.c_uint), ("Mip", C.c_uint), ("Arr", C.c_uint), ("Fmt", C.c_uint),
                ("SC", C.c_uint), ("SQ", C.c_uint), ("Usage", C.c_uint), ("Bind", C.c_uint), ("CPU", C.c_uint), ("Misc", C.c_uint)]
class SAMPDESC(C.Structure):
    _fields_ = [("F", C.c_uint), ("U", C.c_uint), ("V", C.c_uint), ("Wa", C.c_uint), ("Bias", C.c_float), ("Aniso", C.c_uint),
                ("Cmp", C.c_uint), ("Border", C.c_float * 4), ("MinL", C.c_float), ("MaxL", C.c_float)]
class BUFDESC(C.Structure):
    _fields_ = [("Size", C.c_uint), ("Usage", C.c_uint), ("Bind", C.c_uint), ("CPU", C.c_uint), ("Misc", C.c_uint), ("Stride", C.c_uint)]
class SUBRES(C.Structure):
    _fields_ = [("p", P), ("pitch", C.c_uint), ("slice", C.c_uint)]
class VIEWPORT(C.Structure):
    _fields_ = [("x", C.c_float), ("y", C.c_float), ("w", C.c_float), ("h", C.c_float), ("mn", C.c_float), ("mx", C.c_float)]
class QDESC(C.Structure):
    _fields_ = [("Q", C.c_uint), ("Misc", C.c_uint)]
class DISJOINT(C.Structure):
    _fields_ = [("Freq", C.c_uint64), ("Disjoint", C.c_int)]

samp = P()
sd = SAMPDESC(0x15, 3, 3, 3, 0.0, 1, 1, (C.c_float * 4)(0, 0, 0, 0), 0.0, 3.4e38)
check(vcall(dev, 23, HR, C.byref(sd), C.byref(samp)), "CreateSamplerState")
cbdata = struct.pack("8f4f", 1920.0, 1080.0, 3.25, 0.4, 0.3, 0.6, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0)
cbbuf = C.create_string_buffer(cbdata)
cb = P()
check(vcall(dev, 3, HR, C.byref(BUFDESC(48, 0, 0x4, 0, 0, 0)), C.byref(SUBRES(C.cast(cbbuf, P), 0, 0)), C.byref(cb)), "CreateBuffer")

class RASTDESC(C.Structure):
    _fields_ = [("Fill", C.c_uint), ("Cull", C.c_uint), ("FCCW", C.c_int), ("DB", C.c_int), ("DBC", C.c_float), ("SSDB", C.c_float),
                ("DCE", C.c_int), ("SE", C.c_int), ("MSE", C.c_int), ("AALE", C.c_int)]
rs = P()
check(vcall(dev, 22, HR, C.byref(RASTDESC(3, 1, 0, 0, 0.0, 0.0, 1, 0, 0, 0)), C.byref(rs)), "CreateRasterizerState")
vcall(ctx, 43, None, rs)

def query(kind):
    q = P()
    check(vcall(dev, 24, HR, C.byref(QDESC(kind, 0)), C.byref(q)), "CreateQuery")
    return q

def getdata(q, buf):
    for _ in range(10_000_000):
        hr = vcall(ctx, 29, HR, q, C.byref(buf), C.c_uint(C.sizeof(buf)), C.c_uint(0))
        if hr == 0:
            return
        if hr < 0:
            raise RuntimeError(f"GetData hr=0x{hr & 0xffffffff:08x} size={C.sizeof(buf)}")
    raise RuntimeError("GetData timeout")

def bench(w, h, ps, n=200):
    src_t, rt_t, srv, rtv = P(), P(), P(), P()
    import numpy as np
    noise = np.random.default_rng(1).integers(0, 256, size=w * h * 4, dtype=np.uint8)
    init = SUBRES(noise.ctypes.data_as(P), w * 4, 0)
    check(vcall(dev, 5, HR, C.byref(TEXDESC(w, h, 1, 1, 28, 1, 0, 0, 0x8, 0, 0)), C.byref(init), C.byref(src_t)), "tex")
    check(vcall(dev, 5, HR, C.byref(TEXDESC(w, h, 1, 1, 28, 1, 0, 0, 0x20, 0, 0)), P(), C.byref(rt_t)), "rt")
    check(vcall(dev, 7, HR, src_t, P(), C.byref(srv)), "srv")
    check(vcall(dev, 9, HR, rt_t, P(), C.byref(rtv)), "rtv")
    vcall(ctx, 33, None, C.c_uint(1), C.byref(rtv), P())
    vcall(ctx, 44, None, C.c_uint(1), C.byref(VIEWPORT(0, 0, w, h, 0, 1)))
    vcall(ctx, 24, None, C.c_uint(4))
    vcall(ctx, 11, None, vs, P(), C.c_uint(0))
    vcall(ctx, 9, None, ps, P(), C.c_uint(0))
    vcall(ctx, 8, None, C.c_uint(0), C.c_uint(1), C.byref(srv))
    vcall(ctx, 10, None, C.c_uint(1), C.c_uint(1), C.byref(samp))
    vcall(ctx, 16, None, C.c_uint(2), C.c_uint(1), C.byref(cb))
    best = 1e9
    for rep in range(5):
        qd, q0, q1 = query(3), query(2), query(2)
        vcall(ctx, 27, None, qd)
        vcall(ctx, 28, None, q0)
        for _ in range(n):
            vcall(ctx, 13, None, C.c_uint(3), C.c_uint(0))
        vcall(ctx, 28, None, q1)
        vcall(ctx, 28, None, qd)
        dj, t0, t1 = DISJOINT(), C.c_uint64(), C.c_uint64()
        getdata(qd, dj); getdata(q0, t0); getdata(q1, t1)
        if not dj.Disjoint:
            best = min(best, (t1.value - t0.value) / dj.Freq * 1000 / n)
    return best

for (w, h) in [(1920, 1080), (2560, 1440), (3840, 2160)]:
    c = bench(w, h, ps_copy)
    f = bench(w, h, ps_fx)
    print(f"{w}x{h}: passthrough {c*1000:.0f} us/pass, effect {f*1000:.0f} us/pass")
