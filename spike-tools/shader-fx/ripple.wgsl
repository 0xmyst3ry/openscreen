// Ripple d'eau qui part du point de chaque clic : un front circulaire qui s'élargit, suivi de
// deux ou trois vagues concentriques qui réfractent l'image, avec un reflet sur les crêtes.
// param(0) = force (1), param(1) = rayon final en fraction de la hauteur (0.2), param(2) = durée en s (0.9).
fn effect(uv: vec2<f32>) -> vec4<f32> {
    let base = frame(uv);
    if (ctx.click.w < 0.5) {
        return base;
    }
    let duration = select(0.9, param(2), param(2) > 0.0);
    let age = ctx.click.z;
    if (age > duration) {
        return base;
    }
    let t = age / duration;
    let aspect = ctx.resolution.x / ctx.resolution.y;
    let d = (uv - ctx.click.xy) * vec2<f32>(aspect, 1.0);
    let r = length(d);
    let max_r = select(0.2, param(1), param(1) > 0.0);
    let front = max_r * (1.0 - pow(1.0 - t, 3.0));
    // Distance derrière le front : les vagues vivent à l'intérieur du cercle, et s'amortissent.
    let x = front - r;
    let wavelength = 0.03;
    let env = smoothstep(-0.008, 0.0, x) * exp(-max(x, 0.0) / 0.07);
    let fade = (1.0 - t) * (1.0 - t);
    let strength = select(1.0, param(0), param(0) > 0.0);
    let wave = sin(x / wavelength * 6.2831853) * env * fade * strength;
    let dir = select(vec2<f32>(0.0), d / r, r > 1e-5);
    let offset = dir * wave * 0.01 / vec2<f32>(aspect, 1.0);
    let col = frame(uv - offset).rgb;
    let crest = max(wave, 0.0);
    return vec4<f32>(col + vec3<f32>(crest * 0.3), base.a);
}
