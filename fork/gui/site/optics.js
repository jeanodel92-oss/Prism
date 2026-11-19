// The light behind the page: one WebGL scene, drawn on a fixed canvas, whose state
// follows the reading position. Phases (S): 0 a stray reflection, 1 an eclipse,
// 2 its rim flattened into a ridge of black rock, 3 the rock around the screen,
// 4 the prism that was making the light, 5 dawn behind the ridge, 6 daylight and
// a halo around the sun, 7 the moon covering the sun, 8 back to black.
// Without WebGL, or with reduced motion, the page shows still renders of the same
// scene instead (html.still); the content never depends on this file.
(function () {
	"use strict";

	var VERT = "attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}";

	var FRAG = [
		"precision highp float;",
		"uniform vec2 R;uniform float T;uniform float S;uniform vec2 M;uniform vec4 SCR;uniform float SEED;uniform float Q;",
		"float h12(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}",
		"vec2 h22(vec2 p){vec3 q=fract(vec3(p.xyx)*vec3(.1031,.103,.0973));q+=dot(q,q.yzx+33.33);return fract((q.xx+q.yz)*q.zy);}",
		"float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);",
		" return mix(mix(h12(i),h12(i+vec2(1,0)),f.x),mix(h12(i+vec2(0,1)),h12(i+vec2(1,1)),f.x),f.y);}",
		"float fbm(vec2 p){float a=.5,s=0.;for(int i=0;i<5;i++){s+=a*vn(p);p=mat2(1.6,1.2,-1.2,1.6)*p;a*=.5;}return s;}",
		// Three octaves: enough for anything out of focus, at half the cost.
		"float fbm3(vec2 p){float a=.5,s=0.;for(int i=0;i<3;i++){s+=a*vn(p);p=mat2(1.6,1.2,-1.2,1.6)*p;a*=.5;}return s/.875;}",
		// Value noise that wraps in x with period n, for patterns around a circle
		// (an angle from atan would jump by a full turn on the left).
		"float vnp(vec2 p,float n){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);float i0=mod(i.x,n),i1=mod(i.x+1.,n);",
		" return mix(mix(h12(vec2(i0,i.y)),h12(vec2(i1,i.y)),f.x),mix(h12(vec2(i0,i.y+1.)),h12(vec2(i1,i.y+1.)),f.x),f.y);}",
		"float fbp(vec2 p,float n){float a=.5,s=0.;for(int i=0;i<4;i++){s+=a*vnp(p,n);p=p*2.+vec2(0.,1.7);n*=2.;a*=.5;}return s/.9375;}",
		// Screen blend, for light added over the daylight in display values.
		"vec3 scr(vec3 a,vec3 b){return 1.-(1.-a)*(1.-b);}",
		"float sat(float x){return clamp(x,0.,1.);}",
		"float up(float a,float b,float x){return smoothstep(a,b,x);}",
		"float down(float a,float b,float x){return 1.-smoothstep(a,b,x);}",
		"float win(float s,float a,float b,float c,float d){return up(a,b,s)*down(c,d,s);}",
		// Thin-film tint, kept pale: colour is an optical event, not a palette.
		"vec3 film(float t){return .6+.4*cos(6.2832*(t+vec3(0.,.33,.67)));}",
		// Voronoi: x = distance to the nearest site, y = F2-F1 (edges), zw = cell id.
		"vec4 vor(vec2 p){vec2 n=floor(p),f=fract(p);float d1=8.,d2=8.;vec2 id=vec2(0);",
		" for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++){vec2 g=vec2(i,j);vec2 o=h22(n+g);vec2 r=g+o-f;float d=dot(r,r);",
		"  if(d<d1){d2=d1;d1=d;id=n+g;}else if(d<d2){d2=d;}}",
		" return vec4(sqrt(d1),sqrt(d2)-sqrt(d1),id);}",

		// Black faceted stones at a grazing angle, lit from behind by a low source.
		// dd: depth below the ridge; lx: the source's x; zoom: camera closeness;
		// crack: light seeping between the stones along one winding line.
		"vec3 rock(vec2 p,float dd,float lx,float zoom,float focus,float crack){",
		" float z=.2/(dd+.03);",
		" vec2 g=vec2((p.x+M.x*.02)*z*1.25,z+T*.003)*zoom*2.;",
		" vec3 V=normalize(vec3(-p.x*.4,.5,-1.));",
		" vec3 L=normalize(vec3((lx-p.x)*.8+M.x*.12+.16*sin(T*.05),.06+.04*sin(T*.031),1.));",
		" vec3 H=normalize(L+V);vec3 c=vec3(0.);",
		" float far=sat((z-1.2)/7.);",
		" float blur=sat(far*1.15+(1.-focus));",
		" float lump=fbm(g*.25+3.1);float lit=.2+1.6*up(.3,.75,lump);",
		" float cy=mix(-.4,-.1,up(-.9,.9,p.x))+.07*(fbm(vec2(p.x*2.2,1.7))-.5);",
		" float band=exp(-pow((p.y-cy)/.035,2.))*crack;",
		" for(int k=0;k<2;k++){",
		"  vec2 q=g*(k==0?5.:12.)+float(k)*17.3;vec2 n0=floor(q),f=fract(q);",
		"  float d1=8.,d2=8.;vec2 id=vec2(0),rr=vec2(0);",
		"  for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++){vec2 gg=vec2(i,j);vec2 r=gg+h22(n0+gg)-f;float dq=dot(r,r);",
		"   if(dq<d1){d2=d1;d1=dq;id=n0+gg;rr=r;}else if(dq<d2){d2=dq;}}",
		"  d1=sqrt(d1);d2=sqrt(d2);float gap=d2-d1;",
		// Each stone is a low cone of four to six flat facets.
		"  float a=atan(-rr.y,-rr.x);float nf=4.+floor(h12(id)*3.);",
		"  float fa=(floor(a/6.2832*nf+h12(id+1.3))+.5)*6.2832/nf;",
		"  float slope=(.35+.9*h12(id+2.1))*(.5+.5*sat(d1*2.2));",
		"  vec3 n=normalize(vec3(cos(fa)*slope,1.,sin(fa)*slope));",
		"  float nh=max(dot(n,H),0.);float e=h12(id+5.2);",
		"  float glint=pow(nh,mix(420.,40.,blur))*(.25+1.6*e*e);",
		"  float sheen=pow(nh,10.)*.012;",
		"  float bok=down(.15,.42,d1)*pow(nh,18.)*.22*(.3+e);",
		"  float rim=exp(-gap*mix(26.,8.,blur))*sat(-rr.y/max(d1,.01)+.2)*.06*max(L.y*6.,.3);",
		"  float wgt=k==0?1.:.55;",
		"  float lum=(.004*max(dot(n,L),0.)+sheen+mix(glint,bok,blur)+rim*(1.-blur))*wgt;",
		"  float rare=step(.88,h12(id+7.7))*(1.-blur);",
		"  vec3 tint=mix(vec3(1.,.97,.93),film(nh*2.2+e+T*.008),rare*.85);",
		"  c+=tint*lum*lit;",
		"  if(k==0&&band>.001){",
		"   float travel=.2+.8*exp(-pow(fract(p.x*.45-T*.03)-.5,2.)*14.);",
		"   c+=mix(vec3(1.,.95,.88),film(p.x*.7+T*.01),.55)*exp(-gap*gap*900.)*band*travel*.9;",
		"  }",
		" }",
		" c+=vec3(1.,.94,.88)*exp(-dd*9.)*.07*exp(-abs(p.x-lx)*1.6);",
		" return c*(1.-far*.7);}",

		// Triangular prism, slightly rounded so its edges catch the light.
		"mat3 rotm;",
		"float map(vec3 p){vec3 l=rotm*p;vec3 q=abs(l);return max(q.z-.6,max(q.x*.866025+l.y*.5,-l.y)-.3)-.01;}",
		"vec3 nrm(vec3 p){vec2 e=vec2(.0015,0);return normalize(vec3(map(p+e.xyy)-map(p-e.xyy),map(p+e.yxy)-map(p-e.yxy),map(p+e.yyx)-map(p-e.yyx)));}",
		// What the glass sees: darkness, a narrow band of light from the left, a dim
		// soft source above, the rock below.
		"vec3 env(vec3 d){",
		" vec3 Lb=normalize(vec3(-1.,.05,.25));float a=max(dot(d,Lb),0.);",
		" float band=pow(a,700.)*22.+pow(a,60.)*.07;",
		" float box=pow(max(dot(d,normalize(vec3(.3,1.,-.2))),0.),8.)*.012;",
		" float fl=down(-.02,.0,d.y)*.012*(.5+.5*vn(d.xz*9.));",
		" return vec3(band+box+fl);}",
		"float trace(vec3 ro,vec3 rd,out vec3 hp){float t=0.;for(int i=0;i<64;i++){vec3 p=ro+rd*t;float d=map(p);if(d<.0006){hp=p;return t;}t+=d;if(t>6.)break;}return -1.;}",
		"float leave(vec3 ro,vec3 rd,out vec3 hp){float t=.004;for(int i=0;i<40;i++){vec3 p=ro+rd*t;float d=-map(p);if(d<.0006){hp=p;return t;}t+=max(d,.002);}hp=ro+rd*t;return t;}",
		"vec3 glass(vec2 q,out float hit){",
		" vec3 ro=vec3(0.,.04,-3.);vec3 rd=normalize(vec3(q,1.7));",
		" vec3 hp;float t=trace(ro,rd,hp);hit=0.;if(t<0.)return vec3(0.);hit=1.;",
		" vec3 n=nrm(hp);float fr=.04+.96*pow(1.-max(dot(-rd,n),0.),5.);",
		" vec3 col=env(reflect(rd,n))*fr;vec3 tr=vec3(0.);",
		" for(int c=0;c<3;c++){float ior=c==0?1.46:(c==1?1.5:1.55);",
		"  vec3 r1=refract(rd,n,1./ior);vec3 ep;float dl=leave(hp,r1,ep);vec3 n2=-nrm(ep);",
		"  vec3 r2=refract(r1,n2,ior);if(dot(r2,r2)<.01){r2=reflect(r1,n2);}",
		"  vec3 e=env(r2)*exp(-dl*.3);tr[c]=c==0?e.r:(c==1?e.g:e.b);}",
		" col+=tr*(1.-fr);",
		// Edges: where two faces meet, the rounding catches every light around.
		" vec3 l=rotm*hp;float f1=l.x*.866+l.y*.5-.3,f2=-l.x*.866+l.y*.5-.3,f3=-l.y-.3,f4=abs(l.z)-.6;",
		" float m1=max(max(f1,f2),max(f3,f4));float m2=-9.;",
		" if(f1<m1)m2=max(m2,f1);if(f2<m1)m2=max(m2,f2);if(f3<m1)m2=max(m2,f3);if(f4<m1)m2=max(m2,f4);",
		" float edge=exp(-abs(m2)*90.);",
		" col+=edge*(.05+.6*pow(max(dot(reflect(rd,n),normalize(vec3(-1.,.05,.25))),0.),12.))*vec3(1.,.97,.94);",
		" float dust=step(.997,h12(floor(l.xy*700.)+floor(l.z*240.)));",
		" col+=dust*(.04+.4*edge);",
		" return col;}",

		// A light source seen through a lens: core, glow, anamorphic streak, faint spikes.
		"vec3 flare(vec2 p,vec2 s,float I){",
		" vec2 d=p-s;float r=length(d);float a=atan(d.y,d.x);",
		" float c=.0007/(r*r+.0002)+.018*exp(-r*6.)+.004*exp(-r*1.8);",
		" c+=.16*exp(-abs(d.y)*110.)*exp(-abs(d.x)*2.4);",
		" c+=.05*pow(abs(cos(a*3.+.4)),60.)*exp(-r*9.);",
		" return vec3(1.,.95,.89)*c*I;}",
		// Ghost reflections of the source inside the lens, with a chromatic fringe.
		"vec3 ghosts(vec2 p,vec2 s,float I){vec3 c=vec3(0.);vec2 ax=-s;",
		" for(int i=1;i<=2;i++){vec2 gp=s+ax*(.7+float(i)*.55);float rad=.035+.06*float(i);",
		"  float rr=length(p-gp);vec3 ch=vec3(rr-rad*1.05,rr-rad,rr-rad*.95);",
		"  c+=exp(-ch*ch*1800.)*.009+vec3(down(-.02,0.,ch.g))*.0025;}",
		" return c*I;}",

		"void main(){",
		" vec2 fc=gl_FragCoord.xy;vec2 p=(fc-.5*R)/R.y;float A=R.x/R.y;",
		" float port=down(.75,1.25,A);",
		" float s=S;vec3 col=vec3(0.);",
		" float e01=up(0.,1.,s),e12=up(1.,2.,s),e23=up(2.,3.,s),e34=up(3.,4.,s);",
		// Dawn, then day, then back to black after the second eclipse.
		" float dw=up(4.45,5.,s),e56=up(5.,6.,s),e78=up(7.15,7.9,s);",
		// Eclipse geometry: a dark disc whose rim grows until it is a ridge. Each phase
		// gives the lit point of the rim (P), the radius and the source's angle; the
		// centre follows, so the rim stays in view while it flattens.
		" vec2 P0=mix(vec2(A*.13,.70),vec2(.40,.80),port),P1=mix(vec2(A*.38,.46),vec2(.13,.47),port);",
		" vec2 P2=mix(vec2(.30,-.15),vec2(.08,-.03),port),P3=mix(vec2(.24,.30),vec2(.05,.33),port);",
		" float R0=mix(.6,.38,port),R1=mix(.40,.24,port),R2=9.,R3=9.;",
		" float th=mix(mix(mix(mix(2.5,1.,port),mix(.95,1.1,port),e01),1.535,e12),1.56,e23);",
		" float Rd=exp(mix(mix(mix(log(R0),log(R1),e01),log(R2),e12),log(R3),e23));",
		" vec2 P=mix(mix(mix(P0,P1,e01),P2,e12),P3,e23);",
		// At dawn the camera tilts up: the ridge sinks, then leaves the frame.
		" float tilt=.42*dw+.8*e56;P.y-=tilt;",
		" float th0=th;th+=(.08*sin(T*.06)+.03*sin(T*.17))/max(Rd,1.);",
		" vec2 dir=vec2(cos(th),sin(th));vec2 C=P-dir*Rd;",
		// Distance along the rim from the lit point, so the relief stays put while the
		// disc flattens instead of sliding past (the constant keeps the phase-2 ridge).
		" vec2 pc=p-C;float rp=length(pc);float an=atan(pc.y,pc.x);float arc=(an-th0)*Rd+13.815;",
		" float rough=.004*(fbm(vec2(arc*14.,1.3))-.5)*2.;",
		" float ridge=e12*(.07*(fbm(vec2(arc*2.6,5.1))-.45)+.012*(vn(vec2(arc*30.,2.))-.5));",
		// atan jumps by a full turn on the left of the disc: there, cross-fade with
		// the same noise taken from the other side of the jump, so nothing tears.
		" float sw=.5*up(2.85,3.1416,abs(an)),san=an-6.2832*sign(an);",
		" if(sw>0.){float ar=arc-6.2832*sign(an)*Rd;",
		"  rough=mix(rough,.004*(fbm(vec2(ar*14.,1.3))-.5)*2.,sw);",
		"  if(e12>0.)ridge=mix(ridge,e12*(.07*(fbm(vec2(ar*2.6,5.1))-.45)+.012*(vn(vec2(ar*30.,2.))-.5)),sw);}",
		" float d=rp-(Rd+rough+ridge);",
		" float lit=mix(.03,1.,e01)*(1.-e34*.93)*(1.+dw*3.)*(1.-e56);",
		" float ad=acos(clamp(dot(pc/rp,dir),-1.,1.));",
		" float side=Rd>1.?exp(-ad*Rd*1.4):pow(max(cos(ad*.5),0.),26.);",
		" float aw=.018+side;",
		" float ka=8.*min(Rd,1.4),ky=log(max(d,.001))*1.6-T*.02;float str=fbm(vec2(an*ka+T*.01,ky));",
		// Rescaled around the mean so the cross-fade keeps the streamers' contrast.
		" if(sw>0.){str=.48+(mix(str,fbm(vec2(san*ka+T*.01,ky)),sw)-.48)/sqrt(sw*sw+(1.-sw)*(1.-sw));}",
		" str=.55+.9*str;str=mix(str,1.,e12*.75);",
		" float corona=exp(-max(d,0.)*mix(7.,30.,e12))*aw*str*.45*step(0.,d);",
		" float rim=exp(-abs(d)*mix(380.,700.,e12))*(.12+aw*2.2);",
		" col+=vec3(1.,.95,.88)*(corona+rim)*lit;",
		// The hot spot where the source shows past the rim.
		" vec2 hs=C+dir*(Rd+.004+ridge);",
		" float hsI=lit*mix(.3,1.,e01)*(.9+.1*sin(T*.4))*(1.-e23*.65);",
		" col+=flare(p,hs,hsI*.5);",
		" col+=ghosts(p,hs,hsI*(1.-e12))*(1.-port*.6)*.2;",
		// Inside the disc: almost nothing, then rock.
		" float inside=step(d,0.);",
		" float rk=up(1.35,2.05,s)*down(3.55,3.95,s);",
		" float crack=win(s,2.15,2.45,2.7,2.95);",
		" if(inside>.5){",
		"  col+=vec3(.003)*(.6+fbm(p*6.))*(1.-rk);",
		"  if(rk>.001){float zoom=1.+e34*4.;",
		"   col+=rock(p,-d,hs.x,zoom,1.-e34,crack)*rk*(1.-e34*.5);}",
		" }",
		// The stray reflection of the opening, before any object is visible.
		" float leak=down(.2,1.1,s)*(1.-port*.4);",
		" if(leak>.001){vec2 lp=p-vec2(A*.5-.12,.02);float la=-.6+.05*sin(T*.05)+M.x*.02;",
		"  vec2 ld=vec2(cos(la),sin(la));float ac=dot(lp,vec2(-ld.y,ld.x));float al=dot(lp,ld);",
		"  float fall=exp(-abs(al+.2)*1.5);vec3 ch=vec3(ac+.007,ac,ac-.007);",
		"  col+=(exp(-ch*ch*1600.)*.05+exp(-ch*ch*50.)*.01)*fall*leak;}",
		// The screen rests in the rock: contact shadow around its rectangle.
		" if(SCR.z>SCR.x){vec2 sc=(SCR.xy+SCR.zw)*.5;vec2 sh=(SCR.zw-SCR.xy)*.5;",
		"  vec2 q=abs(p-sc)-sh;float sd=length(max(q,0.))+min(max(q.x,q.y),0.);",
		"  col*=mix(1.,up(-.01,.14,sd),.9*win(s,2.5,2.9,3.4,3.7));}",
		// The prism, and the light it bends.
		" float pz=win(s,3.55,4.05,4.55,4.95);",
		" if(pz>.001){",
		"  vec2 pcn=mix(vec2(A*.17,.03),vec2(.07,.06),port);float psz=mix(.62,.3,port);pcn.y-=.42*dw;",
		"  float ang=.6*sin(T*.043)+.2*sin(T*.019)+(s-4.)*.8;",
		"  float ca=cos(ang),sa=sin(ang),cb=cos(.2),sb=sin(.2);",
		"  rotm=mat3(ca,0.,sa,0.,1.,0.,-sa,0.,ca)*mat3(1.,0.,0.,0.,cb,-sb,0.,sb,cb);",
		"  vec2 q=(p-pcn)/psz;float hit=0.;vec3 gc=vec3(0.);",
		"  if(length(q)<.6)gc=glass(q,hit);",
		"  vec2 entry=pcn+vec2(-.09,-.02)*psz;",
		"  vec2 bd=normalize(entry-vec2(-A*.5-.2,-.13));",
		"  vec2 bp=p-entry;float bal=dot(bp,bd);float bac=dot(bp,vec2(-bd.y,bd.x));",
		"  float beam=step(bal,0.)*(exp(-bac*bac*120000.)*.8+exp(-abs(bac)*70.)*.04)*up(-A*1.3,-A*.3,bal);",
		"  float align=exp(-pow(sin(ang-.1),2.)*7.);",
		"  vec2 ex=pcn+vec2(.1,-.03)*psz;vec2 fp=p-ex;float fa=atan(fp.y,fp.x);float fr=length(fp);",
		"  float sp=(fa+.34)/.26;",
		"  vec3 fan=film(sat(sp)*.8+.1)*up(0.,.2,sp)*down(.8,1.,sp)*up(.0,.06,fr)*exp(-fr*1.3);",
		"  float ground=inside>.5?(.4+6.*rock(p,-d,ex.x,1.,1.,0.).r):.5;",
		"  vec3 pc2=gc+vec3(beam)*(1.-hit)+fan*align*.3*ground*(1.-hit*.5);",
		"  float motes=step(.994,h12(floor((p+vec2(T*.004,T*.002))*480.)))*exp(-bac*bac*900.)*step(bal,0.);",
		"  pc2+=vec3(motes)*.3;",
		"  col=col*(1.-pz*.75)+pc2*pz;",
		" }",
		// Exit: everything settles back into black.
		" col*=1.-e78*.95;",
		" col*=down(.3,1.6,length(p*vec2(.78,1.05)));",
		// Film response, then grain that lives in the mid-tones, as on film.
		" col=1.-exp(-col*1.7);",
		// Toe: faint veils stay black, as on a negative, instead of lifting to grey.
		" col=max(col-.0035,0.)*1.0035;",
		" col=pow(col,vec3(1./2.2));",
		// Daylight, in display values. The light the ridge has hidden since the
		// eclipse rises as the sun; the camera tilts up into a sky whose ice crystals
		// are small prisms (a 22 degree halo, two sun dogs); then the moon, lit from
		// the sun's side, thins to nothing as it crosses the sun.
		" float dayv=dw*(1.-e78);",
		" if(dayv>.001){",
		"  float zm=up(6.4,7.,s),mv=up(5.3,6.,s);",
		"  vec2 SF=mix(vec2(A*.2,.04),vec2(0.,.19),port);",
		"  vec2 SD=mix(vec2(A*.27,.25),vec2(.12,.27),port);",
		"  vec2 MD=mix(vec2(-A*.42,.22),vec2(-.17,.4),port);",
		"  float Z=1.+mix(2.4,1.3,port)*zm*zm;vec2 w=SF+(p-SF)/Z;",
		"  vec2 sun=mix(mix(hs+vec2(0.,.03),SD,e56),SF,up(6.,7.,s));",
		"  vec2 moon=mix(MD,sun,pow(up(5.7,7.,s),1.5));",
		"  float sR=mix(.046,.034,port),mR=sR*1.065,hr0=mix(.36,.24,port);",
		"  float unc=sat((length(moon-sun)-(mR-sR))/(2.*sR));float dark=pow(1.-unc,2.5);",
		// Peach, lilac and deep blue at dawn; pale haze to a soft blue by day.
		"  float el=w.y-P.y;float a1=sat(el*1.8),a2=sat(el*.8);",
		"  vec3 sk=mix(mix(mix(vec3(.97,.79,.63),vec3(.56,.48,.57),sqrt(a1)),vec3(.1,.13,.22),a2*a2),",
		"   mix(mix(vec3(.79,.82,.86),vec3(.53,.64,.82),sqrt(a1)),vec3(.32,.47,.74),a2),e56);",
		"  float sd=length(w-sun);",
		"  sk=scr(sk,vec3(1.,.86,.7)*exp(-sd*mix(3.,5.,e56))*mix(.5,.28,e56));",
		"  sk=mix(sk,vec3(.025,.032,.055)+vec3(.07,.04,.02)*exp(-(p.y+.5)*6.),dark);",
		// A pillar of light over the rising sun.
		"  float pil=dw*(1.-e56);",
		"  if(pil>.001){vec2 sp=w-sun;",
		"   sk=scr(sk,vec3(1.,.8,.6)*exp(-abs(sp.x)*mix(70.,26.,sat(sp.y*2.)))*exp(-max(sp.y,0.)*2.6)*up(-.02,.03,sp.y)*.45*pil);}",
		// The sun, hidden by the moon in proportion.
		"  vec2 mq=(w-moon)/mR;float mr=length(mq);float mcv=down(.96,1.02,mr)*mv;",
		"  float sI=down(sR*.9,sR*1.06,sd)*(1.-mcv)*2.2+unc*(.0016/(sd*sd+.0008)+.22*exp(-sd*7.)+.3*e56*exp(-sd*3.));",
		"  sk=scr(sk,mix(vec3(1.,.82,.64),vec3(1.,.96,.9),e56)*(1.-exp(-sI))*(.55+.45*dw)*(1.-mcv*.92));",
		// The moon by day: its unlit part is the sky in front of it.
		"  if(mr<1.1&&mv>.001){",
		"   vec3 mn=vec3(mq,sqrt(max(1.-mr*mr,0.)));vec2 ms=sun-moon;float me=length(ms);",
		"   float pa=3.1416-min(me*2.4,2.2);vec3 ML=vec3(ms/max(me,1e-4)*sin(pa),cos(pa));",
		"   float lam=up(-.05,.25,dot(mn,ML));",
		"   float mar=1.-.2*up(.5,.64,fbm(mq*1.2+7.3))-.08*vn(mq*7.);",
		"   sk=mix(sk,scr(sk*(1.-.9*dark),vec3(.92,.94,.97)*lam*mar*(1.-dark)*.8),mcv);}",
		// The halo: red on its sharp inner edge, white outward, darker sky inside;
		// the sun dogs at the sun's height, a white tail pointing away from it.
		"  float hI=e56*unc*unc;",
		"  if(hI>.001){vec2 hd=w-sun;float tr=(length(hd)-hr0)/hr0;",
		"   float ring=up(-.02,0.,tr)*exp(-max(tr,0.)*13.);",
		"   sk*=1.-.06*hI*up(-.8,-.2,tr)*down(-.06,-.005,tr);",
		"   sk=scr(sk,mix(film(-sat(tr*5.)*.2),vec3(1.),.2+.6*sat(tr*8.))*ring*.24*hI);",
		"   for(int i=0;i<2;i++){float sg=i==0?-1.:1.;vec2 q=hd-vec2(sg*hr0*1.08,0.);float u=sg*q.x;",
		"    float core=exp(-u*u*1400.-q.y*q.y*240.);",
		"    vec3 dt=mix(film(-sat((u+.02)*12.)*.2),vec3(1.),.15+.7*sat(u*25.));",
		"    float tail=exp(-q.y*q.y*5000.)*exp(-max(u,0.)*11.)*up(-.01,.03,u)*.12;",
		"    sk=scr(sk,(dt*core*.5+vec3(tail))*hI);}",
		"   sk=scr(sk,vec3(.05*hI*exp(-hd.y*hd.y*8000.)*up(.1,.5,abs(hd.x))));",
		"  }",
		// A high veil of cloud in perspective, lit from below at dawn.
		"  float cz=.32/max(el,.004);",
		"  float cn=fbm3(vec2(w.x*cz*.9+T*.003,cz+s*.55+T*.006)*vec2(.6,1.5));",
		"  float cd=up(.48,.8,cn)*exp(-cz*.09)*mix(.85,.45,e56)*(1.-dark*.7);",
		"  float fs=exp(-sd*2.2);",
		"  vec3 cc=mix(mix(vec3(.46,.38,.46),vec3(1.,.7,.55),fs),mix(vec3(.76,.79,.85),vec3(.96,.93,.89),.4+.6*fs),e56);",
		"  sk=mix(sk,cc*(1.-dark*.9),cd);",
		// Clouds close to the lens, out of focus, framing the view so that its middle
		// stays clear for reading.
		"  float nv=e56*(1.-zm*.8);",
		"  if(nv>.001){vec2 nq=w*vec2(1.9,2.4)+vec2(T*.006,-s*1.2);",
		"   float n1=fbm3(nq),n2=fbm3(nq+normalize(sun-w)*.12);",
		"   float edg=up(.25,.9,length((w-vec2(0.,.02))*vec2(.6,1.)));",
		"   float nd=up(.5,.74,n1+edg*.6-.16)*nv;",
		"   vec3 nc=mix(vec3(.72,.63,.7),vec3(.93,.87,.8),sat(.5+(n1-n2)*6.));",
		"   sk=mix(sk,nc*(1.-dark*.85),nd*.93);}",
		// Totality: the corona, a few pink prominences on the rim, stars.
		"  if(dark>.001){vec2 cq=w-moon;float cr=length(cq)/mR;float cdd=max(cr-1.,0.);",
		// The angle as a fraction of a turn, for noise that wraps around the disc.
		"   float ct=atan(cq.y,cq.x)/6.2832+T*.0004;float lr=log(cdd+.04);",
		"   float stm=.45+.9*fbp(vec2(ct*25.,lr*1.3-T*.02),25.);",
		// Fine rays, long along the radius; the finest set only where it spans
		// enough pixels not to shimmer.
		"   float cpx=6.2832*cr*mR*Z*R.y;",
		"   float f1=vnp(vec2(ct*90.,lr*.45-T*.01),90.),f2=vnp(vec2(ct*270.,lr*.9+3.7-T*.01),270.);",
		"   float fil=mix(f1,.5*f1+.5*f2,sat(cpx/540.-.5));",
		"   float co=(exp(-cdd*1.8)*stm*(.45+.9*fil)*.7+exp(-cdd*28.)*(.75+.5*fil)*.9)*up(.995,1.01,cr);",
		"   float pr=up(.74,.86,vnp(vec2(ct*56.,1.3),56.))*exp(-pow(cdd*18.,2.))*up(1.,1.012,cr);",
		"   sk=scr(sk,(1.-exp(-vec3(.95,.97,1.)*co-vec3(1.,.38,.5)*pr*.7))*dark);",
		// Stars: one round point at most per cell, its size in pixels.
		"   vec2 sg=p*110.,si=floor(sg);float sh=h12(si+7.1);",
		"   if(sh>.992){float sp=length(sg-si-.3-.4*h22(si+3.3))*R.y/110.;",
		"    sk+=exp(-sp*sp*.8)*(.4+.6*pow(fract(sh*137.),2.))*dark*.9*(1.-mcv);}}",
		// The last bead of sun on the rim, just before totality.
		"  float dia=up(0.,.015,unc)*down(.02,.16,unc)*mv;",
		"  if(dia>.001){vec2 bp=moon+normalize(sun-moon+vec2(1e-5))*mR;sk=scr(sk,1.-exp(-flare(w,bp,dia*1.6)));}",
		"  sk*=1.-.15*sat(length(p*vec2(.62,1.))-.25);",
		"  float above=up(-.003,.006,d);",
		"  col=scr(col,sk*above*dayv+vec3(.11,.075,.06)*exp(min(d,0.)*9.)*(1.-above)*dw*(1.-e56));",
		" }",
		" float l=dot(col,vec3(.3,.59,.11));",
		" float gr=h12(fc+SEED*91.7)-.5;vec3 gch=vec3(h12(fc*1.3+SEED*17.),h12(fc*.7+SEED*41.),h12(fc*1.9+SEED*7.))-.5;",
		" col+=(.012+.07*sqrt(l)*(1.-l))*(gr*.85+gch*.15*Q);",
		" col=max(col,vec3(.019));",
		" gl_FragColor=vec4(col,1.);",
		"}"
	].join("\n");

	function create(canvas, opts) {
		opts = opts || {};
		var gl = canvas.getContext("webgl", { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: !!opts.preserve, powerPreference: "low-power" });
		if (!gl) return null;
		function sh(type, src) {
			var s = gl.createShader(type);
			gl.shaderSource(s, src);
			gl.compileShader(s);
			if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
				if (window.console) console.warn("optics:", gl.getShaderInfoLog(s));
				return null;
			}
			return s;
		}
		var vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, FRAG);
		if (!vs || !fs) return null;
		var prog = gl.createProgram();
		gl.attachShader(prog, vs);
		gl.attachShader(prog, fs);
		gl.linkProgram(prog);
		if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
		gl.useProgram(prog);
		var buf = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, buf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
		var loc = gl.getAttribLocation(prog, "a");
		gl.enableVertexAttribArray(loc);
		gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
		var u = {};
		["R", "T", "S", "M", "SCR", "SEED", "Q"].forEach(function (n) { u[n] = gl.getUniformLocation(prog, n); });
		return {
			gl: gl,
			draw: function (st) {
				gl.viewport(0, 0, canvas.width, canvas.height);
				gl.uniform2f(u.R, canvas.width, canvas.height);
				gl.uniform1f(u.T, st.t);
				gl.uniform1f(u.S, st.s);
				gl.uniform2f(u.M, st.mx || 0, st.my || 0);
				var r = st.screen || [0, 0, 0, 0];
				gl.uniform4f(u.SCR, r[0], r[1], r[2], r[3]);
				gl.uniform1f(u.SEED, st.seed || 0);
				gl.uniform1f(u.Q, st.q == null ? 1 : st.q);
				gl.drawArrays(gl.TRIANGLES, 0, 3);
			}
		};
	}

	window.PrismOptics = { create: create };
})();
