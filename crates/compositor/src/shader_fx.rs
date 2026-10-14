//! Effets shader écrits à l'exécution (spike) : un agent écrit en WGSL une fonction
//! `fn effect(uv: vec2<f32>) -> vec4<f32>`, appliquée en une passe plein cadre sur l'image
//! composée, en preview comme à l'export. Un seul compositeur sert les deux, donc les mêmes pixels.
//!
//! Le WGSL est traduit par naga vers le langage du backend, puis compilé UNE fois, sur un thread
//! de fond, et gardé par hash du source : la boucle de rendu ne compile jamais. Seul Windows
//! dessine la passe pour l'instant ; la validation, elle, tourne partout (outil de l'agent).
//!
//! L'effet est une fonction PURE de l'image composée, du temps et de ses paramètres : pas d'état
//! d'une frame à l'autre, pas d'horloge murale. C'est ce qui garde la preview (qui saute d'une
//! frame à l'autre au seek) et l'export (qui les rend dans l'ordre) d'accord au pixel.

use crate::scene::SceneShaderEffect;
use std::hash::{Hash, Hasher};

/// Ce que l'effet voit en plus de son propre code. Placé APRÈS le code de l'agent : en WGSL
/// l'ordre des déclarations de module est libre, et les numéros de ligne des erreurs tombent
/// ainsi sur les lignes que l'agent a écrites.
///
/// - `frame(uv)` : l'image composée, uv (0,0) en haut à gauche.
/// - `ctx.resolution` : la sortie en px. Un effet raisonne en uv ou en fraction de hauteur, jamais
///   en px : la preview rend plus petit que l'export.
/// - `ctx.time` : secondes de programme, continues à travers coupes et clips.
/// - `ctx.progress` : 0 → 1 à travers la région de l'effet.
/// - `param(i)` : les huit paramètres de la région, i de 0 à 7.
/// - `ctx.cursor` : xy = la pointe du curseur en uv de sortie, z = 1 si elle est à l'écran.
/// - `ctx.click` : xy = le point du dernier clic en uv de sortie, z = secondes écoulées depuis,
///   w = 1 s'il y en a eu un dans les `CLICK_WINDOW_S` dernières secondes.
pub const PRELUDE: &str = r#"
struct FxContext {
    resolution: vec2<f32>,
    time: f32,
    progress: f32,
    params: array<vec4<f32>, 2>,
    cursor: vec4<f32>,
    click: vec4<f32>,
};
@group(0) @binding(0) var fx_frame: texture_2d<f32>;
@group(0) @binding(1) var fx_sampler: sampler;
@group(0) @binding(2) var<uniform> ctx: FxContext;

fn frame(uv: vec2<f32>) -> vec4<f32> {
    return textureSampleLevel(fx_frame, fx_sampler, uv, 0.0);
}

fn param(i: u32) -> f32 {
    return ctx.params[i / 4u][i % 4u];
}

struct FxVsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn fx_vs(@builtin(vertex_index) i: u32) -> FxVsOut {
    let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    var o: FxVsOut;
    o.pos = vec4<f32>(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
    o.uv = p;
    return o;
}

@fragment
fn fx_fs(v: FxVsOut) -> @location(0) vec4<f32> {
    return effect(v.uv);
}
"#;

pub const PARAM_COUNT: usize = 8;

/// Jusqu'où un clic reste visible des effets (`ctx.click`) : au-delà, `w` retombe à 0.
pub const CLICK_WINDOW_S: f32 = 2.0;

/// Le constant buffer de la passe, au layout de `FxContext` (80 octets, multiple de 16).
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FxContext {
    pub resolution: [f32; 2],
    pub time: f32,
    pub progress: f32,
    pub params: [f32; PARAM_COUNT],
    pub cursor: [f32; 4],
    pub click: [f32; 4],
}

/// Ce que le plan du curseur donne aux effets, `None` quand il n'y a pas de curseur à l'écran.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct FxPointer {
    pub cursor: Option<[f32; 2]>,
    pub last_click: Option<([f32; 2], f32)>,
}

pub fn module_source(user: &str) -> String {
    format!("{user}\n{PRELUDE}")
}

fn parse(user: &str) -> Result<(naga::Module, naga::valid::ModuleInfo), String> {
    let src = module_source(user);
    let module = naga::front::wgsl::parse_str(&src).map_err(|e| e.emit_to_string(&src))?;
    let info = naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::empty(),
    )
    .validate(&module)
    .map_err(|e| e.emit_to_string(&src))?;
    Ok((module, info))
}

/// L'erreur telle que l'agent doit la lire (ligne, colonne, extrait), ou `Ok`.
pub fn validate(user: &str) -> Result<(), String> {
    parse(user).map(|_| ())
}

/// HLSL SM 5.0 pour D3D11/FXC. naga 24 est la dernière version dont la sortie HLSL passe FXC :
/// à partir de la 25 elle déclare les samplers dans un tas D3D12 (`register(s0, space0)`), que
/// `ps_5_0` refuse (X3721). Ne pas monter naga sans revérifier ce test.
pub fn to_hlsl(user: &str) -> Result<String, String> {
    let (module, info) = parse(user)?;
    let options = naga::back::hlsl::Options {
        shader_model: naga::back::hlsl::ShaderModel::V5_0,
        ..Default::default()
    };
    let mut out = String::new();
    naga::back::hlsl::Writer::new(&mut out, &options)
        .write(&module, &info, None)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// Clé du cache des shaders compilés.
pub fn source_hash(user: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    user.hash(&mut h);
    h.finish()
}

/// L'effet actif au temps source `t`, et sa progression dans la région. Le premier qui couvre `t`
/// l'emporte : un seul effet par frame dans ce spike.
pub fn active_effect(effects: &[SceneShaderEffect], t: f32) -> Option<(&SceneShaderEffect, f32)> {
    let t = t as f64;
    effects.iter().find(|e| t >= e.start_sec && t < e.end_sec).map(|e| {
        let span = (e.end_sec - e.start_sec).max(1e-6);
        (e, ((t - e.start_sec) / span).clamp(0.0, 1.0) as f32)
    })
}

pub fn context(
    effect: &SceneShaderEffect,
    progress: f32,
    programme_t: f32,
    resolution: [f32; 2],
    pointer: FxPointer,
) -> FxContext {
    let mut params = [0.0; PARAM_COUNT];
    for (slot, value) in params.iter_mut().zip(&effect.params) {
        *slot = *value;
    }
    let cursor = pointer.cursor.map_or([0.0; 4], |[x, y]| [x, y, 1.0, 0.0]);
    let click = pointer.last_click.map_or([0.0; 4], |([x, y], age)| [x, y, age, 1.0]);
    FxContext { resolution, time: programme_t, progress, params, cursor, click }
}

/// Le bytecode DXBC des deux étages, prêt pour `CreateVertexShader` / `CreatePixelShader`.
#[cfg(windows)]
pub struct CompiledFx {
    pub vs: Vec<u8>,
    pub ps: Vec<u8>,
}

#[cfg(windows)]
pub fn compile_dxbc(user: &str) -> Result<CompiledFx, String> {
    let hlsl = to_hlsl(user)?;
    Ok(CompiledFx {
        vs: d3d_compile(&hlsl, "fx_vs", "vs_5_0")?,
        ps: d3d_compile(&hlsl, "fx_fs", "ps_5_0")?,
    })
}

#[cfg(windows)]
fn d3d_compile(hlsl: &str, entry: &str, profile: &str) -> Result<Vec<u8>, String> {
    use windows::core::PCSTR;
    use windows::Win32::Graphics::Direct3D::Fxc::{D3DCompile, D3DCOMPILE_OPTIMIZATION_LEVEL3};
    use windows::Win32::Graphics::Direct3D::ID3DBlob;

    fn bytes(blob: &ID3DBlob) -> Vec<u8> {
        unsafe {
            std::slice::from_raw_parts(blob.GetBufferPointer() as *const u8, blob.GetBufferSize())
                .to_vec()
        }
    }
    let (entry_z, profile_z) = (format!("{entry}\0"), format!("{profile}\0"));
    let (mut code, mut errors): (Option<ID3DBlob>, Option<ID3DBlob>) = (None, None);
    let compiled = unsafe {
        D3DCompile(
            hlsl.as_ptr().cast(),
            hlsl.len(),
            PCSTR(b"effect.hlsl\0".as_ptr()),
            None,
            None,
            PCSTR(entry_z.as_ptr()),
            PCSTR(profile_z.as_ptr()),
            D3DCOMPILE_OPTIMIZATION_LEVEL3,
            0,
            &mut code,
            Some(&mut errors),
        )
    };
    match (compiled, code) {
        (Ok(()), Some(code)) => Ok(bytes(&code)),
        (result, _) => {
            let log = errors.as_ref().map(bytes).unwrap_or_default();
            Err(format!("{entry}: {result:?}\n{}", String::from_utf8_lossy(&log)))
        }
    }
}

/// Compile sur un thread à part ; le résultat arrive par le canal. naga + FXC prennent ~10 ms
/// pour un effet de 60 lignes, soit une frame de preview : jamais sur le thread de rendu.
#[cfg(windows)]
pub fn spawn_compile(code: String) -> std::sync::mpsc::Receiver<Result<CompiledFx, String>> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("shader-fx".into())
        .spawn(move || {
            let _ = tx.send(compile_dxbc(&code));
        })
        .expect("thread shader-fx");
    rx
}

#[cfg(test)]
mod tests {
    use super::*;

    const VIGNETTE: &str = r#"
fn effect(uv: vec2<f32>) -> vec4<f32> {
    let c = frame(uv);
    let d = distance(uv, vec2<f32>(0.5));
    return vec4<f32>(c.rgb * (1.0 - d * param(0) * ctx.progress), c.a);
}
"#;

    fn region(start: f64, end: f64) -> SceneShaderEffect {
        SceneShaderEffect {
            clip_index: Some(0),
            start_sec: start,
            end_sec: end,
            code: VIGNETTE.into(),
            params: vec![1.0, 2.0],
        }
    }

    #[test]
    fn a_valid_effect_becomes_hlsl_that_d3d11_accepts() {
        let hlsl = to_hlsl(VIGNETTE).expect("translate");
        assert!(hlsl.contains("fx_vs") && hlsl.contains("fx_fs"));
        // Les registres que `Compositor::draw_shader_effect` lie : t0, s1, b2, sans `space`.
        assert!(hlsl.contains("register(t0)"), "{hlsl}");
        assert!(hlsl.contains("register(s1)"), "{hlsl}");
        assert!(hlsl.contains("register(b2)"), "{hlsl}");
        assert!(!hlsl.contains("space"), "FXC ps_5_0 refuse les espaces de registres");
    }

    #[test]
    fn an_error_points_at_the_line_the_agent_wrote() {
        let broken = "fn effect(uv: vec2<f32>) -> vec4<f32> {\n    return frame(uv) * nope;\n}\n";
        let err = validate(broken).expect_err("must fail");
        assert!(err.contains("nope"), "{err}");
        assert!(err.contains(":2:"), "line 2 of the agent's code: {err}");
    }

    #[test]
    fn an_effect_without_the_entry_function_is_refused() {
        assert!(validate("fn other() {}").is_err());
    }

    #[test]
    fn the_context_is_80_bytes_like_its_wgsl_struct() {
        assert_eq!(std::mem::size_of::<FxContext>(), 80);
    }

    #[test]
    fn the_active_region_and_its_progress() {
        let effects = [region(1.0, 3.0)];
        assert!(active_effect(&effects, 0.5).is_none());
        let (_, p) = active_effect(&effects, 2.0).unwrap();
        assert!((p - 0.5).abs() < 1e-6);
        assert!(active_effect(&effects, 3.0).is_none(), "end is exclusive");
        let ctx = context(&effects[0], 0.5, 10.0, [1920.0, 1080.0], FxPointer::default());
        assert_eq!(ctx.params, [1.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
        assert_eq!((ctx.cursor[2], ctx.click[3]), (0.0, 0.0), "pas de curseur, pas de clic");
        let pointer = FxPointer { cursor: Some([0.25, 0.5]), last_click: Some(([0.3, 0.6], 0.2)) };
        let ctx = context(&effects[0], 0.5, 10.0, [1920.0, 1080.0], pointer);
        assert_eq!((ctx.cursor, ctx.click), ([0.25, 0.5, 1.0, 0.0], [0.3, 0.6, 0.2, 1.0]));
    }

    #[cfg(windows)]
    #[test]
    fn fxc_compiles_both_stages() {
        let c = compile_dxbc(VIGNETTE).expect("compile");
        assert!(!c.vs.is_empty() && !c.ps.is_empty());
    }
}
