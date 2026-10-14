// Aberration chromatique + barillet, grain, scanlines, anneau pulsé, vignette.
fn hash2(p: vec2<f32>) -> f32 {
    let q = fract(p * vec2<f32>(123.34, 456.21));
    let r = q + dot(q, q + 45.32);
    return fract(r.x * r.y);
}

fn barrel(uv: vec2<f32>, k: f32) -> vec2<f32> {
    let c = uv - 0.5;
    return 0.5 + c * (1.0 + k * dot(c, c));
}

fn effect(uv0: vec2<f32>) -> vec4<f32> {
    let strength = params.strength * sin(ctx.region.x * 3.14159265);
    let uv = barrel(uv0, 0.15 * strength);
    let off = (uv - 0.5) * 0.006 * strength;
    var col = vec3<f32>(frame(uv + off).r, frame(uv).g, frame(uv - off).b);
    let px = uv0 * ctx.resolution;
    let grain = hash2(px + vec2<f32>(fract(ctx.time * 24.0) * 97.0, 0.0)) - 0.5;
    col += grain * 0.06;
    col *= 0.92 + 0.08 * sin(px.y * 3.14159265);
    let d = distance(uv0 * ctx.resolution, vec2<f32>(0.5) * ctx.resolution) / ctx.resolution.y;
    let ring = smoothstep(0.02, 0.0, abs(d - fract(ctx.time) * 0.3));
    col += vec3<f32>(0.3, 0.6, 1.0) * ring;
    let v = uv0 - 0.5;
    col *= 1.0 - dot(v, v) * 1.2;
    let inside = all(uv >= vec2<f32>(0.0)) && all(uv <= vec2<f32>(1.0));
    return vec4<f32>(select(vec3<f32>(0.0), col, inside), 1.0);
}
