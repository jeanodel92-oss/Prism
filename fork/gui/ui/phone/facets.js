// The phone's home: a flat mosaic of glass slabs over a textured ground, one slab per recent session of the folder and
// one for a new session. Each slab is a thin convex polyhedron traced exactly per pixel: the light refracts through it,
// is absorbed by its session's tint, and reads the ground lower down, red, green and blue a little apart (the
// dispersion breaks the beam of light). A session at work lights its slab in its tint; that light breathes. Nothing
// else moves: a band of light that swept the glass was too much. Titles are DOM over the canvas.
//
// Three passes. The ground (the costly noise) is baked once per size and theme into a texture. The slabs are traced
// once per layout into textures, in linear light: the colour unlit, and the colour of the slabs at work fully lit (the
// light of a session at work enters every term linearly). A quick image at half the CSS resolution comes first; the
// full one (the device's pixel ratio, up to 3, four samples a pixel when the device can) replaces it band by band, a
// few milliseconds a frame. While a slab breathes, each frame only composes: a blend of the two colours.

import { compile, context, fit, moving } from "./glass.js";

const MAX = 8;
/** Planes per slab, at most: one row of the planes' texture each. */
const MAXP = 80;
/** Width units (the canvas's width is 1). */
const GAP = 0.012;
const RHO = 0.034;
const TH = 0.018;
const SC = 0.8;
/** The header's height when it cannot be measured, in CSS px. */
const HEAD = 54;
/** The quick first image, in device pixels per CSS pixel. Slower than SLOW_FALLBACK (ms): the CSS tiles. */
const PREVIEW_RATIO = 0.5;
const SLOW_FALLBACK = 1000;
/** The full image: the device's pixel ratio up to this, traced in bands of about BAND_MS a frame. */
const MAX_RATIO = 3;
const BAND_MS = 14;
/** Four samples a pixel when the full image is expected to take less than this (ms) in all, else one. */
const AA_BUDGET_MS = 3000;
/** Red and blue read the ground this far apart from green, relative to the refraction's offset (0.5 was far too much). */
const DISP = 0.08;
/** The dark theme's exposure, applied to the whole image before its finish: the background 1.5 to 2 times darker. */
const DARK_EXPOSURE = 0.55;
/** Frames while a slab breathes; slower than SLOW_FRAME_MS (ms): the image stays still. */
const FRAME_MS = 33;
const SLOW_FRAME_MS = 30;

const VERTEX = "#version 300 es\nin vec2 a;void main(){gl_Position=vec4(a,0.,1.);}";

// The ground: slate (dark) or marble (light), with a beam of light and quartz veins drawn on it. Baked: RGB the rock
// (gamma 2; light: halved, the marble goes up to about 1.3), A the beam and veins (gamma 2; dark: divided by 4, they
// go up to about 3). The veins are faint (broken into colours everywhere, they took over the image)
// . BEAM: 1, or 0 for the ground without its beam (the PC cannot be reached).
const GROUND = `#version 300 es
precision highp float;
uniform vec2 R;uniform float LIGHT;uniform float BEAM;
out vec4 outColor;
float h2(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
 return mix(mix(h2(i),h2(i+vec2(1,0)),f.x),mix(h2(i+vec2(0,1)),h2(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float a=.5,s=0.;for(int i=0;i<5;i++){s+=a*vnoise(p);p=p*2.03+vec2(17.3,9.1);a*=.5;}return s;}
float veins(vec2 q,float f,float sharp){
 float w=fbm(q*2.3+f)*5.;float v=abs(sin(dot(q,vec2(.8,.6))*f+w));return pow(1.-v,sharp);}
vec3 gbase(vec2 q){
 float asp=R.y/R.x;
 float n0=fbm(q*7.);
 vec2 Ld=normalize(vec2(-.5,-.6));
 float n1=fbm((q+Ld*.004)*7.);
 float fine=fbm(q*40.+5.);
 if(LIGHT<.5){
  float diff=clamp(.62+(n1-n0)*26.+(fine-.5)*.3,0.,1.3);
  float pool=exp(-dot(q-vec2(.3,.3*asp),q-vec2(.3,.3*asp))*.9);
  float pool2=exp(-dot(q-vec2(.9,.85*asp),q-vec2(.9,.85*asp))*2.);
  vec3 alb=vec3(.05,.052,.058)*(.5+1.*n0);
  return alb*(.15+diff*(.4+1.6*pool)+.7*pool2*vec3(.7,.85,1.));
 }
 float diff=clamp(.62+(n1-n0)*12.+(fine-.5)*.1,0.,1.3);
 return vec3(.93,.92,.9)*(.92+.1*n0)*(.55+.6*diff);}
float gfeat(vec2 q){
 float asp=R.y/R.x;
 float v1=veins(q,9.,50.),v2=veins(q*1.7+3.,6.,90.);
 float bd=dot(q-vec2(0.,.63*asp),normalize(vec2(.23,1.)));
 if(LIGHT<.5)return .05*v1+.03*v2+BEAM*(2.8*exp(-bd*bd/.000012)+.2*exp(-bd*bd/.0012));
 return clamp(1.-.3*v1-.18*v2-BEAM*(.85*exp(-bd*bd/.00002)+.14*exp(-bd*bd/.0012)),0.,1.);}
void main(){
 vec2 q=vec2(gl_FragCoord.x,R.y-gl_FragCoord.y)/R.x;
 float f=gfeat(q);
 outColor=vec4(sqrt(clamp(gbase(q)*(LIGHT<.5?1.:.5),0.,1.)),sqrt(clamp(LIGHT<.5?f*.25:f,0.,1.)));}
`;

// Vignette, tone curve, display gamma, a little grain: the last step of every image.
const FINISH = `vec3 finish(vec3 c){
 vec2 uv=gl_FragCoord.xy/R;
 float vig=smoothstep(1.15,.35,length((uv-vec2(.5,.52))*vec2(1.05,1.25)));
 if(LIGHT<.5)c*=.5+.5*vig;else c*=.92+.08*vig;
 c=c/(1.+c*.55);
 c=pow(c,vec3(1./2.2));
 c+=(h2(gl_FragCoord.xy)-.5)*.014;
 return c;}
`;

// The slabs: the brief's reference shader (annex B), the ground read from the baked texture. Out: the colour in linear
// light; ENC 1 (no float targets): squeezed into 0..1, c/(1+c).
const SLABS = `#version 300 es
precision highp float;
uniform vec2 R;uniform float BR;uniform float LIGHT;uniform int AA;uniform int ENC;
uniform vec3 P[${MAX}];uniform vec4 C[${MAX}];uniform int N;uniform float DISP;uniform sampler2D PLT;uniform int CNT[${MAX}];
uniform sampler2D GT;
out vec4 outColor;
float h2(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float box(vec3 d,vec3 c,vec3 ux,float w,float h,float soft){
 vec3 x=normalize(ux-c*dot(ux,c));vec3 y=cross(c,x);float f=dot(d,c);if(f<=0.)return 0.;
 vec2 p=vec2(dot(d,x),dot(d,y))/f;vec2 e=abs(p)-vec2(w,h);return smoothstep(soft,-soft,max(e.x,e.y));}
vec3 env(vec3 d){
 vec3 c;
 if(LIGHT<.5){
  c=vec3(.006,.0065,.008)*(.5+.5*d.z);
  c+=vec3(1.,.93,.84)*3.2*box(d,normalize(vec3(-.5,-.6,.62)),vec3(1,0,0),.46,.3,.2);
  c+=vec3(.8,.9,1.)*2.4*box(d,normalize(vec3(.86,.05,.5)),vec3(0,1,0),.6,.07,.1);
  c+=vec3(1.,.88,.76)*1.3*box(d,normalize(vec3(.15,.9,.42)),vec3(1,0,0),.3,.07,.1);
  c+=vec3(.9,.95,1.)*1.1*box(d,normalize(vec3(-.3,-.36,.88)),vec3(1,0,0),.34,.34,.3);
  c+=vec3(1.)*14.*(pow(max(dot(d,normalize(vec3(.35,-.5,.79))),0.),3000.)+pow(max(dot(d,normalize(vec3(-.7,.3,.65))),0.),4000.));
  c=mix(c,vec3(.003),smoothstep(.02,-.2,d.z));
 }else{
  c=vec3(.9,.9,.88)*(.22+.3*d.z);
  c+=vec3(1.)*1.9*box(d,normalize(vec3(-.3,-.36,.88)),vec3(1,0,0),.34,.34,.3);
  c*=1.-.9*box(d,normalize(vec3(.8,.2,.56)),vec3(0,1,0),.6,.12,.1);
  c*=1.-.85*box(d,normalize(vec3(-.3,.85,.43)),vec3(1,0,0),.4,.1,.1);
  c*=1.-.7*box(d,normalize(vec3(-.75,-.2,.62)),vec3(0,1,0),.3,.08,.1);
  c+=vec3(1.,.97,.92)*2.2*box(d,normalize(vec3(-.5,-.6,.62)),vec3(1,0,0),.4,.26,.2);
  c=mix(c,vec3(.78,.78,.76),smoothstep(.02,-.2,d.z));
 }
 return c;}
vec3 PN[${MAXP}];float PD[${MAXP}];int PC;
void build(int i1){
 PC=CNT[i1];
 for(int j=0;j<${MAXP};j++){if(j>=PC)break;vec4 pl=texelFetch(PLT,ivec2(j,i1),0);PN[j]=pl.xyz;PD[j]=pl.w;}}
void hullIn(vec3 O,vec3 d,out float t1,out vec3 n1,out float t2,out vec3 n2,out float tout){
 t1=-1e9;t2=-1e9;tout=1e9;n1=vec3(0,0,1);n2=n1;
 for(int j=0;j<${MAXP};j++){if(j>=PC)break;
  float dn=dot(d,PN[j]);float t=(PD[j]-dot(O,PN[j]))/dn;
  if(dn<0.){if(t>t1){t2=t1;n2=n1;t1=t;n1=PN[j];}else if(t>t2){t2=t;n2=PN[j];}}
  else if(dn>0.)tout=min(tout,t);}}
void hullOut(vec3 O,vec3 d,out float t,out vec3 n){
 t=1e9;n=vec3(0,0,1);
 for(int j=0;j<${MAXP};j++){if(j>=PC)break;
  float dn=dot(d,PN[j]);if(dn>1e-5){float tt=(PD[j]-dot(O,PN[j]))/dn;if(tt<t){t=tt;n=PN[j];}}}
 t=max(t,0.);}
float schlick(float c,float f0){return f0+(1.-f0)*pow(1.-clamp(c,0.,1.),5.);}
// The baked ground, at a point in width units (y down).
vec4 gtex(vec2 q){return texture(GT,vec2(q.x,1.-q.y*R.x/R.y));}
vec3 gbase(vec2 q){vec3 c=gtex(q).rgb;return LIGHT<.5?c*c:c*c*2.;}
float gfeat(vec2 q){float a=gtex(q).a;a*=a;return LIGHT<.5?a*4.:a;}
vec3 ground3(vec2 gr,vec2 gg,vec2 gb){
 vec3 b=gbase(gg);vec3 f=vec3(gfeat(gr),gfeat(gg),gfeat(gb));
 return LIGHT<.5?b+vec3(1.,.97,.93)*f:b*f;}
vec3 ground(vec2 q){return ground3(q,q,q);}
vec3 shade(vec2 fc){
 float asp=R.y/R.x;
 vec2 q=vec2(fc.x,R.y-fc.y)/R.x;
 const float ZG=.14;
 vec3 d=normalize(vec3((q-vec2(.5,.5*asp))*.1,-1.));
 vec2 g0=q+d.xy*ZG/(-d.z);
 int i1=0;float best=1e9;
 for(int i=0;i<${MAX};i++){if(i>=N)break;vec2 v=q-P[i].xy;float dd=dot(v,v)-P[i].z;if(dd<best){best=dd;i1=i;}}
 vec2 s=P[i1].xy;vec3 tint=vec3(1.);float act=0.;
 for(int i=0;i<${MAX};i++){if(i==i1){tint=C[i].rgb;act=C[i].a;}}
 build(i1);
 vec3 O=vec3(q-s,0.)-d*(1./-d.z);
 float t1,t2,tout;vec3 n1,n2;
 hullIn(O,d,t1,n1,t2,n2,tout);
 vec3 ts=tint*tint;ts/=max(ts.r,max(ts.g,ts.b));
 // C.a: 0 unlit, 1 at work (its light breathes: BR), 2 waiting for an answer (its light steady).
 float lit=act>1.5?.75:act*BR;
 if(t1>=tout)return ground(g0)*(LIGHT<.5?.2:.07)*(1.+2.5*lit)+ts*lit*(LIGHT<.5?.05:.0);
 vec3 Pp=O+d*t1;
 float ior=1.55;float f0=.085;
 float F=schlick(dot(-d,n1),f0);
 // The room's reflection: soft, so a facet does not turn into a flat patch of one shade.
 vec3 g=min(env(reflect(d,n1))*F*(LIGHT<.5?1.8:2.4),vec3(LIGHT<.5?.26:.36));
 vec2 eg=n1.xy/dot(d,n1)-n2.xy/dot(d,n2);
 float edge=smoothstep(.0022,.0004,(t1-t2)/max(length(eg),1e-3));
 vec3 Hh=normalize(normalize(vec3(-.5,-.6,.62))-d);
 float bev=smoothstep(.2,.5,max(length(n1.xy),length(n2.xy)));
 edge*=smoothstep(.985,.9,dot(n1,n2));
 g+=vec3(1.,.97,.92)*edge*(bev*(.03+.8*pow(max(dot(normalize(n1+n2),Hh),0.),30.))+(1.-bev)*(LIGHT<.5?.02:.08));
 g+=ts*lit*smoothstep(.2,.5,length(n1.xy))*(LIGHT<.5?.5:.25);
 vec3 dd=refract(d,n1,1./ior);vec3 thr=vec3(1.-F);
 vec3 sig=-log(max(mix(tint,ts,.6),vec3(.02)))*(LIGHT<.5?24.:95.);
 for(int b=0;b<4;b++){
  float t;vec3 n;hullOut(Pp,dd,t,n);
  thr*=exp(-sig*t);
  g+=thr*ts*t*(LIGHT<.5?1.1+1.6*lit:.15+.4*lit);
  Pp+=dd*t;
  vec3 ro=refract(dd,-n,ior);
  if(dot(ro,ro)>0.){
   float Fo=schlick(dot(ro,n),f0);vec3 e;
   if(ro.z<0.){
    vec2 gp=Pp.xy+s+ro.xy*((Pp.z+ZG)/(-ro.z));vec2 dev=gp-g0;
    e=ground3(g0+dev*(1.-DISP),gp,g0+dev*(1.+DISP));
    vec3 Lk=normalize(vec3(-.5,-.6,.62));
    e*=clamp((1.+(LIGHT<.5?1.1:3.)*(dot(-n,Lk)-.62))*(1.+(LIGHT<.5?3.:10.)*(dot(n1,Lk)-.62)),.3,1.7);
    e+=ts*lit*(LIGHT<.5?.7:.2)*exp(-dot(gp-s,gp-s)*9.);
   }else{
    vec3 rr=refract(dd,-n,ior-.015);vec3 rb=refract(dd,-n,ior+.015);
    if(dot(rr,rr)==0.)rr=ro;if(dot(rb,rb)==0.)rb=ro;
    e=vec3(env(rr).r,env(ro).g,env(rb).b);
   }
   g+=thr*(1.-Fo)*e;thr*=Fo;
  }
  if(max(thr.r,max(thr.g,thr.b))<.02)break;
  dd=reflect(dd,n);
 }
 g+=thr*ground(g0)*.7;
 return g;}
void main(){
 vec3 c=vec3(0.);
 for(int j=0;j<4;j++){if(j>=AA)break;for(int i=0;i<4;i++){if(i>=AA)break;
  c+=shade(gl_FragCoord.xy+(vec2(float(i),float(j))+.5)/float(AA)-.5);}}
 c/=float(AA*AA);
 outColor=ENC==1?vec4(c/(1.+c),1.):vec4(c,1.);}
`;

// Every frame: the full image where it is traced (rows above DONE, from the top), the quick one below; the slabs at
// work blended between unlit and lit by BR; then the finish.
const COMPOSE = `#version 300 es
precision highp float;
uniform vec2 R;uniform float BR;uniform float LIGHT;uniform int ENC;uniform float DONE;
uniform sampler2D C0;uniform sampler2D L0;uniform sampler2D C1;uniform sampler2D L1;
out vec4 outColor;
float h2(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
${FINISH}
vec3 dec(vec3 c){return ENC==1?c/max(1.-c,vec3(1e-3)):c;}
void main(){
 vec4 col;vec4 lit;
 if(gl_FragCoord.y>=R.y-DONE){ivec2 p=ivec2(gl_FragCoord.xy);col=texelFetch(C0,p,0);lit=texelFetch(L0,p,0);}
 else{vec2 uv=gl_FragCoord.xy/R;col=texture(C1,uv);lit=texture(L1,uv);}
 vec3 c=mix(dec(col.rgb),dec(lit.rgb),BR*lit.a);
 if(LIGHT<.5)c*=${DARK_EXPOSURE.toFixed(3)};
 outColor=vec4(finish(c),1.);}
`;


/**
 * Places the slabs: a power diagram relaxed twice (Lloyd), so each cell is round enough to hold a title and a recent
 * session's is larger. Width units: x over 0..1, y over `top`..`aspect` (height over width). `weights` in 0..1. Each
 * site also gets its cell's centre of gravity (cx, cy), where its title goes.
 */
export function layout(count, aspect, weights, top = 0) {
	if (!count) return [];
	let seed = 7;
	const rand = () => {
		seed = (seed * 16807) % 2147483647;
		return seed / 2147483647;
	};
	const sites = Array.from({ length: count }, (_, i) => ({
		x: 0.1 + 0.8 * rand(),
		y: top + (aspect - top) * (0.05 + 0.9 * ((i + 0.5 + (rand() - 0.5) * 0.6) / count)),
		w: 0.05 * (weights[i] ?? 0.5),
		cx: 0,
		cy: 0,
	}));
	const nx = 40;
	const ny = Math.max(1, Math.round(nx * (aspect - top)));
	for (let iteration = 0; iteration < 3; iteration++) {
		const sum = sites.map(() => ({ x: 0, y: 0, n: 0 }));
		for (let j = 0; j < ny; j++) {
			for (let i = 0; i < nx; i++) {
				const x = (i + 0.5) / nx;
				const y = top + ((j + 0.5) / ny) * (aspect - top);
				const k = nearest(sites, x, y);
				sum[k].x += x;
				sum[k].y += y;
				sum[k].n++;
			}
		}
		sites.forEach((site, k) => {
			if (!sum[k].n) {
				site.cx = site.x;
				site.cy = site.y;
				return;
			}
			site.cx = sum[k].x / sum[k].n;
			site.cy = sum[k].y / sum[k].n;
			// Two passes move the sites; the third only measures: the cells stay irregular, cut glass, not a honeycomb.
			if (iteration < 2) {
				site.x = site.cx;
				site.y = site.cy;
			}
		});
	}
	return sites;
}

export function nearest(sites, x, y) {
	let best = 0;
	let bestDistance = Infinity;
	sites.forEach((site, k) => {
		const d = (x - site.x) ** 2 + (y - site.y) ** 2 - site.w;
		if (d < bestDistance) {
			bestDistance = d;
			best = k;
		}
	});
	return best;
}

const hash = (n) => {
	const v = Math.sin(n * 91.3458) * 47453.5453;
	return v - Math.floor(v);
};

/** The part of a convex polygon on the inner side of a line (normal (nx, ny) from (sx, sy), at distance m). */
function clip(poly, nx, ny, m, sx, sy) {
	const out = [];
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i];
		const b = poly[(i + 1) % poly.length];
		const da = (a[0] - sx) * nx + (a[1] - sy) * ny - m;
		const db = (b[0] - sx) * nx + (b[1] - sy) * ny - m;
		if (da <= 0) out.push(a);
		if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
			const t = da / (da - db);
			out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
		}
	}
	return out;
}

/** A slab's outline: its cell of the power diagram, drawn in by half a seam, within the area under the header. */
export function outline(sites, k, aspect, top = 0) {
	const s = sites[k];
	const margin = GAP * 0.5 + 0.006;
	let poly = [
		[margin, top + margin],
		[1 - margin, top + margin],
		[1 - margin, aspect - margin],
		[margin, aspect - margin],
	];
	sites.forEach((o, j) => {
		if (j === k) return;
		const ex = o.x - s.x;
		const ey = o.y - s.y;
		const length = Math.hypot(ex, ey);
		if (!length) return;
		poly = clip(poly, ex / length, ey / length, (length * length + s.w - o.w) / (2 * length) - GAP * 0.5, s.x, s.y);
	});
	return poly.filter((v, i) => {
		const next = poly[(i + 1) % poly.length];
		return Math.hypot(v[0] - next[0], v[1] - next[1]) > 1e-4;
	});
}

/**
 * The planes of slab `k`, each [nx, ny, nz, d] (unit normal pointing out, in the frame centred on its site): the
 * outline with rounded corners, bevelled sides, a flat top cut in four shallow facets, and an underside of one facet
 * per side plus three shallow cuts (brief, annex C).
 */
export function slab(sites, k, aspect, top = 0) {
	const s = sites[k];
	const poly = outline(sites, k, aspect, top);
	const planes = [];
	const add = (x, y, z, d) => {
		const l = Math.hypot(x, y, z);
		planes.push([x / l, y / l, z / l, d / l]);
	};
	const side = (nx, ny, m, sp) => {
		add(SC * nx, SC * ny, 1, m * SC);
		add(sp * nx, sp * ny, -1, m * sp);
	};
	add(0, 0, 1, TH + 0.006);
	const n = poly.length;
	const edges = poly.map((a, i) => {
		const b = poly[(i + 1) % n];
		const dx = b[0] - a[0];
		const dy = b[1] - a[1];
		const len = Math.hypot(dx, dy);
		const nx = dy / len;
		const ny = -dx / len;
		return { nx, ny, len, m: (a[0] - s.x) * nx + (a[1] - s.y) * ny, sp: 0.14 + 0.3 * hash(k * 9.1 + i * 3.3) };
	});
	for (const e of edges) side(e.nx, e.ny, e.m, e.sp);
	poly.forEach((v, i) => {
		const A = edges[(i + n - 1) % n];
		const B = edges[i];
		const phi = Math.acos(Math.max(-1, Math.min(1, A.nx * B.nx + A.ny * B.ny)));
		if (phi < 0.15) return;
		const rho = Math.min(RHO, (0.45 * Math.min(A.len, B.len)) / Math.tan(phi / 2));
		let bx = A.nx + B.nx;
		let by = A.ny + B.ny;
		const bl = Math.hypot(bx, by);
		bx /= bl;
		by /= bl;
		const cx = v[0] - (bx * rho) / Math.cos(phi / 2);
		const cy = v[1] - (by * rho) / Math.cos(phi / 2);
		const turn = Math.sign(A.nx * B.ny - A.ny * B.nx);
		const K = Math.max(1, Math.ceil(phi / 0.35) - 1);
		for (let q = 1; q <= K; q++) {
			const th = (turn * phi * q) / (K + 1);
			const nx = A.nx * Math.cos(th) - A.ny * Math.sin(th);
			const ny = A.nx * Math.sin(th) + A.ny * Math.cos(th);
			side(nx, ny, (cx - s.x) * nx + (cy - s.y) * ny + rho, A.sp + ((B.sp - A.sp) * q) / (K + 1));
		}
	});
	const support = (dx, dy) => Math.max(...poly.map((v) => (v[0] - s.x) * dx + (v[1] - s.y) * dy));
	for (let q = 0; q < 4; q++) {
		const a = hash(k * 3.1 + q * 1.7) * 1.1 + (q * Math.PI) / 2;
		const st = 0.015 + 0.025 * hash(k * 5.3 + q * 2.9);
		const f = 0.25 + 0.4 * hash(k * 7.7 + q * 4.3);
		const dx = Math.cos(a);
		const dy = Math.sin(a);
		add(st * dx, st * dy, 1, TH + st * (support(dx, dy) - (f * TH) / st));
	}
	for (let q = 0; q < 3; q++) {
		const a = hash(k * 4.7 + q * 6.1) * Math.PI * 2;
		const sq = 0.1 + 0.22 * hash(k * 2.3 + q * 8.9);
		const dx = Math.cos(a);
		const dy = Math.sin(a);
		add(sq * dx, sq * dy, -1, sq * support(dx, dy) * (1.05 + 0.3 * hash(k * 6.1 + q * 1.3)));
	}
	return { planes: planes.slice(0, MAXP), poly };
}

/** Where a convex polygon crosses the horizontal line at `y`: [left, right], or undefined if it does not. */
export function chord(poly, y) {
	let left = Infinity;
	let right = -Infinity;
	for (let i = 0; i < poly.length; i++) {
		const [ax, ay] = poly[i];
		const [bx, by] = poly[(i + 1) % poly.length];
		if ((ay - y) * (by - y) > 0 || ay === by) continue;
		const x = ax + ((y - ay) / (by - ay)) * (bx - ax);
		left = Math.min(left, x);
		right = Math.max(right, x);
	}
	return left <= right ? [left, right] : undefined;
}

/**
 * Where a title goes on its slab (width units): centred on the cell's centre of gravity, moved sideways and narrowed
 * so that a band of `height` around it stays `inset` inside the slab's outline. `width` is the title's natural width.
 */
export function fitLabel(poly, cx, cy, width, height, inset) {
	let left = -Infinity;
	let right = Infinity;
	for (const y of [cy - height / 2, cy, cy + height / 2]) {
		const span = chord(poly, y);
		if (!span) continue;
		left = Math.max(left, span[0] + inset);
		right = Math.min(right, span[1] - inset);
	}
	if (!(right > left)) return { x: cx, width };
	const shown = Math.min(width, right - left);
	return { x: Math.min(Math.max(cx, left + shown / 2), right - shown / 2), width: shown };
}

/** How a slab is lit: 1 a session at work (its light breathes), 2 one waiting for an answer (steady), 0 neither. */
const litOf = (item) => (item.waiting ? 2 : item.active ? 1 : 0);



export class Facets {
	/** `onPick(item)` when a slab is touched. Items: { key, title, meta, tint, weight, active, waiting, done }. */
	constructor(canvas, labels, onPick) {
		this.canvas = canvas;
		this.labels = labels;
		this.onPick = onPick;
		this.items = [];
		this.sites = [];
		this.boxes = [];
		this.running = false;
		this.start = performance.now();
		/** Frames too slow to animate: the image stays still (the breathing at t = 12). */
		this.still = false;
		this.beamOn = true;
		const gl = context(canvas, { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
		// WebGL 2 only (the shader reads the planes with texelFetch); without it, the titles become tiles of CSS glass
		// (phone.css .no-gl), touched directly.
		this.gl = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext ? gl : undefined;
		if (!this.gl || !this.#init()) {
			this.#fallback();
			return;
		}
		canvas.addEventListener("webglcontextlost", (event) => {
			event.preventDefault();
			this.ready = false;
		});
		canvas.addEventListener("webglcontextrestored", () => {
			if (this.#init()) {
				this.scene = "";
				this.place();
			} else this.#fallback();
		});
		canvas.addEventListener("click", (event) => {
			if (this.fallen) return;
			const rect = canvas.getBoundingClientRect();
			const k = nearest(this.sites, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.width);
			if (this.items[k]) this.onPick(this.items[k]);
		});
		new ResizeObserver(() => this.place()).observe(canvas);
		// The other theme: traced again (the frame sees the change).
		document.addEventListener("prism-appearance", () => this.loop());
	}

	/** Programs, textures and framebuffers; false if the device refuses them. */
	#init() {
		const gl = this.gl;
		try {
			this.groundProgram = compile(gl, VERTEX, GROUND);
			this.slabProgram = compile(gl, VERTEX, SLABS);
			this.composeProgram = compile(gl, VERTEX, COMPOSE);
		} catch (error) {
			console.warn("phone home: shader", error);
			return false;
		}
		const uniforms = (program, names) => Object.fromEntries(names.map((name) => [name, gl.getUniformLocation(program, name)]));
		this.ug = uniforms(this.groundProgram, ["R", "LIGHT", "BEAM"]);
		this.us = uniforms(this.slabProgram, ["R", "BR", "LIGHT", "AA", "ENC", "P", "C", "N", "DISP", "PLT", "CNT", "GT"]);
		this.uc = uniforms(this.composeProgram, ["R", "BR", "LIGHT", "ENC", "DONE", "C0", "L0", "C1", "L1"]);
		this.groundTexture = gl.createTexture();
		this.groundBuffer = gl.createFramebuffer();
		this.planeTexture = gl.createTexture();
		// Linear light goes above 1: float targets, or (ENC) values squeezed into 0..1 where the device has none.
		this.enc = gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float") ? 0 : 1;
		this.full = this.#target();
		this.preview = this.#target();
		this.baked = "";
		this.traced = "";
		this.ready = true;
		return true;
	}

	/** A set of the traced textures: colour unlit, colour of the slabs at work fully lit; and their framebuffers. */
	#target() {
		const gl = this.gl;
		return { width: 0, height: 0, color: gl.createTexture(), lit: gl.createTexture(), main: gl.createFramebuffer(), litBuffer: gl.createFramebuffer() };
	}

	/** Sizes a set of textures; false if the device cannot draw into them. */
	#size(target, width, height, filter) {
		const gl = this.gl;
		target.width = width;
		target.height = height;
		for (const texture of [target.color, target.lit]) {
			gl.activeTexture(gl.TEXTURE2);
			gl.bindTexture(gl.TEXTURE_2D, texture);
			if (this.enc) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
			else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		}
		gl.bindFramebuffer(gl.FRAMEBUFFER, target.main);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.color, 0);
		const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
		gl.bindFramebuffer(gl.FRAMEBUFFER, target.litBuffer);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.lit, 0);
		// Nothing lit until traced: its alpha says where the breathing applies.
		gl.disable(gl.SCISSOR_TEST);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		return complete && gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
	}

	#fallback() {
		this.fallen = true;
		this.running = false;
		this.labels.classList.add("no-gl");
		this.canvas.style.visibility = "hidden";
		this.place();
	}

	set(items) {
		this.items = items.slice(0, MAX);
		this.place();
	}

	/** The header's height over the canvas's width: the slabs start under it. */
	#top(width) {
		const head = this.canvas.parentElement?.querySelector(".phone-head");
		return (head?.offsetHeight || HEAD) / width;
	}

	place() {
		const rect = this.canvas.getBoundingClientRect();
		if (!rect.height || !rect.width) return;
		const aspect = rect.height / rect.width;
		const top = this.#top(rect.width);
		this.sites = layout(
			this.items.length,
			aspect,
			this.items.map((item) => item.weight),
			top,
		);
		this.labels.replaceChildren(
			...this.items.map((item, k) => {
				const label = document.createElement("div");
				label.className = "facet-label";
				label.style.left = `${this.sites[k].cx * 100}%`;
				label.style.top = `${(this.sites[k].cy / aspect) * 100}%`;
				const title = document.createElement("span");
				title.className = "facet-title";
				title.textContent = item.title;
				const meta = document.createElement("span");
				meta.className = "facet-meta";
				meta.textContent = item.meta;
				label.append(title, meta);
				if (item.waiting) label.classList.add("waiting");
				else if (item.active) label.classList.add("active");
				else if (item.done) label.classList.add("done");
				const rgb = (factor) => `rgb(${item.tint.rgb.map((v) => Math.round(Math.min(1, v * factor) * 255)).join(" ")})`;
				label.style.setProperty("--tint", rgb(1));
				// The dot before "at work": the tint lightened on the dark ground, darkened on the light one.
				label.style.setProperty("--dot-dark", rgb(1.25));
				label.style.setProperty("--dot-light", rgb(0.7));
				if (this.fallen) label.addEventListener("click", () => this.onPick(item));
				return label;
			}),
		);
		const outlines = this.items.map((_, k) => outline(this.sites, k, aspect, top));
		// A title stays inside its slab, clear of the bevel: narrowed (it wraps, two lines at most) and moved sideways
		// where the slab is narrow. Twice: the narrowed title may take two lines, and a taller band.
		if (!this.fallen) {
			const inset = (SC * TH + GAP) * 1.5 + 6 / rect.width;
			[...this.labels.children].forEach((label, k) => {
				const natural = label.offsetWidth / rect.width;
				for (let pass = 0; pass < 2; pass++) {
					const fit = fitLabel(outlines[k], this.sites[k].cx, this.sites[k].cy, natural, label.offsetHeight / rect.width, inset);
					label.style.maxWidth = `${fit.width * rect.width}px`;
					label.style.left = `${fit.x * 100}%`;
				}
			});
		}
		if (this.fallen || !this.gl || !this.ready) return;
		// The glass is traced again only when what it shows changed: the cells, a tint, a light. The titles and their
		// "2 hours ago" are DOM; a refresh that changes only those keeps the image.
		const scene = JSON.stringify([aspect.toFixed(4), top.toFixed(4), this.items.map((item, k) => [item.key, item.tint.rgb, litOf(item), item.weight, k])]);
		if (scene !== this.scene) {
			this.scene = scene;
			// The planes: one row per slab, one plane per texel.
			const gl = this.gl;
			const data = new Float32Array(MAXP * MAX * 4);
			this.counts = new Int32Array(MAX);
			this.boxes = this.items.map((_, k) => {
				const { planes, poly } = slab(this.sites, k, aspect, top);
				this.counts[k] = planes.length;
				planes.forEach((plane, j) => {
					data.set(plane, (k * MAXP + j) * 4);
				});
				const xs = poly.map((v) => v[0]);
				const ys = poly.map((v) => v[1]);
				return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
			});
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, this.planeTexture);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, MAXP, MAX, 0, gl.RGBA, gl.FLOAT, data);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
			this.placed = (this.placed ?? 0) + 1;
		}
		this.loop();
	}

	show(on) {
		this.running = on && Boolean(this.gl) && !this.fallen;
		this.loop();
	}

	/** The ground's beam of light, on or off: off while the PC cannot be reached. */
	beam(on) {
		if (this.beamOn === on) return;
		this.beamOn = on;
		this.loop();
	}

	/** Whether frames keep coming once the image is traced: a slab breathing (a session at work). */
	#animated() {
		return moving() && !this.still && this.items.some((item) => litOf(item) === 1);
	}

	/** Frames while the home is shown: the tracing, band by band, then the breathing (30 a second at most). */
	loop() {
		if (!this.running || this.looping || this.fallen) return;
		this.looping = true;
		const tick = () => {
			if (!this.running || this.fallen || !this.ready) {
				this.looping = false;
				return;
			}
			const tracing = this.#frame();
			if (!tracing && !this.#animated()) {
				this.looping = false;
				return;
			}
			if (tracing) requestAnimationFrame(tick);
			else setTimeout(() => requestAnimationFrame(tick), FRAME_MS);
		};
		requestAnimationFrame(tick);
	}

	/** Bakes the ground into its texture when the size, the theme or its beam changed (2x at most: it is soft). */
	#bake(light) {
		const gl = this.gl;
		const ratio = Math.min(window.devicePixelRatio || 1, 2);
		const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
		const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
		const key = `${width}x${height}:${light}:${this.beamOn}`;
		if (this.baked === key) return;
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.groundTexture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.groundBuffer);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.groundTexture, 0);
		gl.useProgram(this.groundProgram);
		gl.disable(gl.SCISSOR_TEST);
		gl.viewport(0, 0, width, height);
		gl.uniform2f(this.ug.R, width, height);
		gl.uniform1f(this.ug.LIGHT, light);
		gl.uniform1f(this.ug.BEAM, this.beamOn ? 1 : 0);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		this.baked = key;
	}

	/** Traces rows `y0` to `y1` (GL rows, from the bottom) of a set: all the slabs unlit, then the breathing ones lit. */
	#trace(target, light, y0, y1, aa) {
		const gl = this.gl;
		gl.useProgram(this.slabProgram);
		const u = this.us;
		gl.uniform2f(u.R, target.width, target.height);
		gl.uniform1f(u.LIGHT, light);
		gl.uniform1i(u.AA, aa);
		gl.uniform1i(u.ENC, this.enc);
		gl.uniform1f(u.DISP, DISP);
		const sites = new Float32Array(MAX * 3);
		const tints = new Float32Array(MAX * 4);
		this.items.forEach((item, k) => {
			sites.set([this.sites[k].x, this.sites[k].y, this.sites[k].w], k * 3);
			tints.set([...item.tint.rgb, litOf(item)], k * 4);
		});
		gl.uniform3fv(u.P, sites);
		gl.uniform4fv(u.C, tints);
		gl.uniform1i(u.N, this.items.length);
		gl.uniform1iv(u.CNT, this.counts);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.planeTexture);
		gl.uniform1i(u.PLT, 0);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.groundTexture);
		gl.uniform1i(u.GT, 1);
		gl.viewport(0, 0, target.width, target.height);
		gl.enable(gl.SCISSOR_TEST);
		gl.bindFramebuffer(gl.FRAMEBUFFER, target.main);
		gl.uniform1f(u.BR, 0);
		gl.scissor(0, y0, target.width, y1 - y0);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		// Each breathing slab's box, a seam's width around (its light reaches its seam), within the rows.
		gl.bindFramebuffer(gl.FRAMEBUFFER, target.litBuffer);
		gl.uniform1f(u.BR, 1);
		const scale = target.width;
		this.items.forEach((item, k) => {
			if (litOf(item) !== 1 || !this.boxes[k]) return;
			const b = this.boxes[k];
			const x0 = Math.max(0, Math.floor((b.x0 - GAP) * scale));
			const x1 = Math.min(target.width, Math.ceil((b.x1 + GAP) * scale));
			const by0 = Math.max(y0, Math.floor(target.height - (b.y1 + GAP) * scale));
			const by1 = Math.min(y1, Math.ceil(target.height - (b.y0 - GAP) * scale));
			if (x1 <= x0 || by1 <= by0) return;
			gl.scissor(x0, by0, x1 - x0, by1 - by0);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		});
		gl.disable(gl.SCISSOR_TEST);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	}

	/** The image on the canvas, from the traced textures, at `t` seconds. */
	#compose(light, t) {
		const gl = this.gl;
		gl.useProgram(this.composeProgram);
		const u = this.uc;
		const width = this.canvas.width;
		const height = this.canvas.height;
		gl.viewport(0, 0, width, height);
		gl.uniform2f(u.R, width, height);
		gl.uniform1f(u.LIGHT, light);
		gl.uniform1i(u.ENC, this.enc);
		gl.uniform1f(u.BR, 0.75 + 0.25 * Math.sin(t * 1.6));
		gl.uniform1f(u.DONE, this.done);
		[this.full.color, this.full.lit, this.preview.color, this.preview.lit].forEach((texture, i) => {
			gl.activeTexture(gl.TEXTURE2 + i);
			gl.bindTexture(gl.TEXTURE_2D, texture);
		});
		["C0", "L0", "C1", "L1"].forEach((name, i) => {
			gl.uniform1i(u[name], 2 + i);
		});
		gl.disable(gl.SCISSOR_TEST);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	/** Waits for the device and returns how long since `began` (ms): gl.finish() does not wait in Android's WebView
	 *; reading a pixel does. */
	#took(began) {
		this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, new Uint8Array(4));
		return performance.now() - began;
	}

	/** One frame: the next step of the tracing if it is not done, then the image. True while tracing remains. */
	#frame() {
		const gl = this.gl;
		if (!this.items.length || !this.counts) return false;
		fit(this.canvas, MAX_RATIO);
		const width = this.canvas.width;
		const height = this.canvas.height;
		const light = document.documentElement.dataset.appearance === "light" ? 1 : 0;
		const key = `${width}x${height}:${light}:${this.placed}:${this.beamOn}`;
		const animated = this.#animated();
		const t = animated ? (performance.now() - this.start) / 1000 : 12;
		const began = performance.now();
		if (this.traced !== key) {
			// The quick image, whole, then the full one from the top. The ground is baked first and apart: only the
			// tracing is a measure of what the full image will cost.
			this.#bake(light);
			this.#took(began);
			const traced = performance.now();
			const ratio = PREVIEW_RATIO / Math.min(window.devicePixelRatio || 1, MAX_RATIO);
			const ok =
				this.#size(this.preview, Math.max(1, Math.round(width * ratio)), Math.max(1, Math.round(height * ratio)), gl.LINEAR) &&
				this.#size(this.full, width, height, gl.NEAREST);
			if (!ok) {
				this.#fallback();
				return false;
			}
			this.#trace(this.preview, light, 0, this.preview.height, 1);
			this.done = 0;
			this.#compose(light, t);
			const took = this.#took(traced);
			// Only the context's very first image is a measure of the device: one slow image while the app starts must
			// not give up the scene for good.
			if (this.firstImageMs === undefined) {
				this.firstImageMs = took;
				if (took > SLOW_FALLBACK) {
					this.#fallback();
					return false;
				}
			}
			// Four samples a pixel if the full image, at the quick one's pace, takes less than AA_BUDGET_MS.
			const perPixel = took / (this.preview.width * this.preview.height);
			this.aa = perPixel * width * height * 4 < AA_BUDGET_MS ? 2 : 1;
			this.band = Math.max(4, Math.round(BAND_MS / (perPixel * width * this.aa * this.aa)));
			this.traced = key;
			this.framed = false;
			return true;
		}
		if (this.done < height) {
			const rows = Math.min(this.band, height - this.done);
			this.#trace(this.full, light, height - this.done - rows, height - this.done, this.aa);
			this.done += rows;
			// The band's size follows the tracing alone (the image after it costs the same whatever the band).
			const took = this.#took(began);
			this.band = Math.max(4, Math.min(height, Math.round((this.band * BAND_MS) / Math.max(1, took))));
			this.#compose(light, t);
			return this.done < height;
		}
		this.#compose(light, t);
		// The first frame that only composes is timed: too slow to keep up 30 a second, the image stays still.
		if (!this.framed) {
			this.framed = true;
			if (animated && this.#took(began) > SLOW_FRAME_MS) {
				this.still = true;
				this.#compose(light, 12);
			}
		}
		return false;
	}
}
