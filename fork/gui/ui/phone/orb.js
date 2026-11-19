// The orb of the quick switcher: a ball of fluid light that mixes the tint of the
// session aimed at with its neighbours', slowly folding on itself. Changing the aim glides its colours to the new
// session's in 450 ms.

import { compile, context, fit, moving, VERTEX } from "./glass.js";

const FRAGMENT = `precision highp float;
uniform vec2 R;uniform float T;uniform float LIGHT;uniform vec3 A0;uniform vec3 A1;uniform vec3 A2;
// One ribbon of light: a sheet folding through the ball along a curve that breathes, its colour strongest at its
// folded edges, transparent in its middle, as a sheet of coloured glass seen at a grazing angle.
vec4 ribbon(vec2 p,float a,float f,float ph,float amp,vec3 col){
 vec2 u=mat2(cos(a),-sin(a),sin(a),cos(a))*p;
 float env=exp(-u.x*u.x*1.6);
 float y=amp*env*sin(u.x*f+ph);
 float w=(.07+.3*env*(.6+.4*sin(u.x*2.3-ph*.7)));
 float d=abs(u.y-y);
 float body=smoothstep(w,w*.15,d);
 float fold=smoothstep(w*.55,w,d)*smoothstep(w*1.12,w*.92,d);
 float al=(body*.42+fold*.75)*env;
 return vec4(col*al,al);
}
void main(){
 vec2 p=(gl_FragCoord.xy-R*.5)/(R.y*.5)*1.08;
 float r=length(p);
 float t=T;
 vec3 c=vec3(.012,.014,.03);
 // Three ribbons, each turning and folding at its own pace; light adds where they cross.
 vec4 a=ribbon(p,.4+.35*sin(t*.31),2.6,t*.9,.38,A0*1.1);
 vec4 b=ribbon(p,2.3+.4*sin(t*.27+1.),2.1,-t*.75+1.7,.42,A1);
 vec4 d=ribbon(p,4.1+.3*sin(t*.23+2.),3.,t*.62+3.1,.33,A2);
 c+=a.rgb+b.rgb+d.rgb;
 float overlap=a.a*b.a+b.a*d.a+a.a*d.a;
 c+=vec3(1.)*overlap*.35;
 // The white heart, breathing a little.
 c+=vec3(1.)*exp(-r*r*(14.+3.*sin(t*1.3)))*.75+mix(A0,vec3(1.),.5)*exp(-r*r*3.5)*.18;
 // The ball: dark glass, a thin rim catching the light, a soft reflection up left.
 c*=1.-.35*smoothstep(.55,1.,r);
 float edge=smoothstep(1.,.975,r);
 c+=vec3(.75,.8,.95)*smoothstep(.9,.99,r)*edge*.22;
 c+=vec3(1.)*smoothstep(.5,.0,length((p-vec2(-.38,.5))*vec2(1.,1.7)))*.1;
 float halo=exp(-max(r-.99,0.)*10.)*(1.-edge)*.4;
 vec3 col=c*edge+(A0*.6+A1*.2+A2*.2)*halo;
 float alpha=max(edge,halo);
 gl_FragColor=vec4(col*alpha,alpha);
}`;

export class Orb {
	constructor(canvas) {
		this.canvas = canvas;
		this.running = false;
		this.start = performance.now();
		this.from = null;
		this.to = null;
		this.changed = 0;
		this.gl = context(canvas, { premultipliedAlpha: true, alpha: true });
		if (!this.gl) return;
		this.program = compile(this.gl, VERTEX, FRAGMENT);
		this.u = Object.fromEntries(["R", "T", "LIGHT", "A0", "A1", "A2"].map((name) => [name, this.gl.getUniformLocation(this.program, name)]));
		this.gl.enable(this.gl.BLEND);
		this.gl.blendFunc(this.gl.ONE, this.gl.ONE_MINUS_SRC_ALPHA);
	}

	/** Aims at a session: `colours` = [its tint, its neighbours' two], as [r, g, b] in 0..1. */
	aim(colours) {
		this.from = this.current();
		this.to = colours;
		this.changed = performance.now();
		if (!this.from) this.from = colours;
		if (!this.running) this.draw();
	}

	current() {
		if (!this.to) return null;
		const k = Math.min(1, (performance.now() - this.changed) / 450);
		const ease = 1 - (1 - k) ** 3;
		return this.to.map((colour, i) => colour.map((v, j) => this.from[i][j] + (v - this.from[i][j]) * ease));
	}

	show(on) {
		this.running = on && Boolean(this.gl);
		if (this.running && moving()) this.loop();
		else this.draw();
	}

	loop() {
		if (!this.running) return;
		this.draw();
		requestAnimationFrame(() => this.loop());
	}

	draw() {
		const gl = this.gl;
		const colours = this.current();
		if (!gl || !colours) return;
		fit(this.canvas);
		gl.viewport(0, 0, this.canvas.width, this.canvas.height);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.uniform2f(this.u.R, this.canvas.width, this.canvas.height);
		gl.uniform1f(this.u.T, moving() ? (performance.now() - this.start) / 1000 : 4);
		gl.uniform1f(this.u.LIGHT, document.documentElement.dataset.appearance === "light" ? 1 : 0);
		gl.uniform3fv(this.u.A0, colours[0]);
		gl.uniform3fv(this.u.A1, colours[1]);
		gl.uniform3fv(this.u.A2, colours[2]);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}
}
