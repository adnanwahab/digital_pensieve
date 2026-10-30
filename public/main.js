import * as THREE from './vendor/three.module.js';

(() => {
const W = 220;                                   // world size in metres
const H = (x,z) => 5*Math.sin(x*.035)*Math.cos(z*.03) + 2.5*Math.sin(x*.08+1.3)*Math.sin(z*.07+.4) + 1.2*Math.sin((x+z)*.15);
let seed = 11; const rnd = () => (seed = seed*16807 % 2147483647, (seed-1)/2147483646);
const coarse = matchMedia('(pointer:coarse)').matches;
const reduced = matchMedia('(prefers-reduced-motion:reduce)').matches;

/* renderer / scene */
const probe = document.createElement('canvas');
if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) {
  const end = document.getElementById('end');
  end.innerHTML = 'Petal Wind needs WebGL<small>Try a recent Chrome, Firefox, Safari or Edge</small>';
  end.hidden = false; document.getElementById('hint').hidden = true;
  return;
}
const renderer = new THREE.WebGLRenderer({antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio, coarse ? 1.5 : 1.75));
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, .1, 400);
const fogCol = new THREE.Color();
scene.fog = new THREE.Fog(fogCol, 30, 115);

/* color mask: where the meadow has woken up */
const mc = document.createElement('canvas'); mc.width = mc.height = 256;
const mx = mc.getContext('2d'); mx.fillStyle = '#000'; mx.fillRect(0,0,256,256);
mx.globalCompositeOperation = 'lighter';
const mask = new THREE.CanvasTexture(mc); mask.flipY = false;
function paint(x,z,r,a){
  const cx=(x/W+.5)*256, cy=(z/W+.5)*256, rr=r/W*256;
  const g=mx.createRadialGradient(cx,cy,0,cx,cy,rr);
  g.addColorStop(0,`rgba(255,255,255,${a})`); g.addColorStop(1,'rgba(255,255,255,0)');
  mx.fillStyle=g; mx.beginPath(); mx.arc(cx,cy,rr,0,7); mx.fill(); mask.needsUpdate=true;
}

const U = { uTime:{value:0}, uMask:{value:mask}, uLeader:{value:new THREE.Vector3()},
  uWorld:{value:W}, uFog:{value:fogCol}, uNear:{value:30}, uFar:{value:115} };

/* sky */
const skyTop = new THREE.Color(), skyHor = new THREE.Color();
const sky = new THREE.Mesh(new THREE.SphereGeometry(300,32,16), new THREE.ShaderMaterial({
  side:THREE.BackSide, depthWrite:false, fog:false,
  uniforms:{ top:{value:skyTop}, hor:{value:skyHor}, sun:{value:new THREE.Vector3(-.4,.18,-1).normalize()} },
  vertexShader:`varying vec3 vd; void main(){ vd=normalize(position); vec4 p=projectionMatrix*modelViewMatrix*vec4(position,1.); gl_Position=p.xyww; }`,
  fragmentShader:`uniform vec3 top,hor,sun; varying vec3 vd;
    void main(){ float h=clamp(vd.y,0.,1.); vec3 c=mix(hor,top,pow(h,.55));
      float s=max(dot(vd,sun),0.); c+=vec3(1.,.82,.6)*(pow(s,40.)*.6+pow(s,4.)*.18);
      gl_FragColor=vec4(c,1.); }`
}));
scene.add(sky);

/* ground */
const gg = new THREE.PlaneGeometry(W,W,160,160); gg.rotateX(-Math.PI/2);
{ const p=gg.attributes.position; for(let i=0;i<p.count;i++) p.setY(i,H(p.getX(i),p.getZ(i))); gg.computeVertexNormals(); }
scene.add(new THREE.Mesh(gg, new THREE.ShaderMaterial({ uniforms:U,
  vertexShader:`uniform sampler2D uMask; uniform float uWorld; varying float vB,vF,vS;
    void main(){ vec4 wp=modelMatrix*vec4(position,1.); vB=texture2D(uMask,wp.xz/uWorld+.5).r;
      vS=.55+.45*normal.y*dot(normalize(vec3(-.4,1.,-.6)),normal); vec4 mv=viewMatrix*wp;
      vF=smoothstep(30.,115.,-mv.z); gl_Position=projectionMatrix*mv; }`,
  fragmentShader:`uniform vec3 uFog; varying float vB,vF,vS;
    void main(){ vec3 c=mix(vec3(.22,.21,.2),vec3(.09,.25,.1),clamp(vB,0.,1.))*vS; gl_FragColor=vec4(mix(c,uFog,vF),1.); }`
})));

/* grass */
const BLADES = coarse ? 50000 : 95000;
const bladeGeo = new THREE.BufferGeometry();
{ const v=[], idx=[], S=4;
  for(let i=0;i<=S;i++){ const t=i/S, w=.11*(1-t*.9); v.push(-w,t,t*t*.15, w,t,t*t*.15); }
  for(let i=0;i<S;i++){ const a=i*2; idx.push(a,a+1,a+2, a+1,a+3,a+2); }
  bladeGeo.setAttribute('position',new THREE.Float32BufferAttribute(v,3)); bladeGeo.setIndex(idx); }
const rand = new Float32Array(BLADES);
const grass = new THREE.InstancedMesh(bladeGeo, new THREE.ShaderMaterial({ uniforms:U, side:THREE.DoubleSide,
  vertexShader:`uniform float uTime,uWorld; uniform sampler2D uMask; uniform vec3 uLeader;
    attribute float aRand; varying float vT,vB,vF,vR;
    void main(){ vec4 wp=modelMatrix*instanceMatrix*vec4(position,1.); float t=position.y; vT=t; vR=aRand;
      vB=texture2D(uMask,wp.xz/uWorld+.5).r;
      float w=sin(uTime*1.3+wp.x*.12+wp.z*.09+aRand*2.)*.35+sin(uTime*2.7+wp.x*.4+wp.z*.3)*.08;
      wp.x+=w*t*t; wp.z+=w*.6*t*t;
      vec2 d=wp.xz-uLeader.xz; float dl=length(d)+.001;
      float push=exp(-dl*dl/9.)*exp(-max(uLeader.y-wp.y,0.)*.35)*t*1.6;
      wp.xz+=d/dl*push; wp.y-=push*.35;
      vec4 mv=viewMatrix*wp; vF=smoothstep(30.,115.,-mv.z); gl_Position=projectionMatrix*mv; }`,
  fragmentShader:`uniform vec3 uFog; varying float vT,vB,vF,vR;
    void main(){ vec3 dry=mix(vec3(.2,.19,.18),vec3(.55,.51,.44)+vR*.06,vT);
      vec3 tip=mix(vec3(.4,.74,.24),vec3(.7,.84,.3),vR);
      vec3 lush=mix(vec3(.05,.2,.08),tip,vT);
      vec3 c=mix(dry,lush,clamp(vB,0.,1.)); gl_FragColor=vec4(mix(c,uFog,vF),1.); }`
}), BLADES);
{ const m=new THREE.Matrix4(), q=new THREE.Quaternion(), s=new THREE.Vector3(), p=new THREE.Vector3(), up=new THREE.Vector3(0,1,0);
  for(let i=0;i<BLADES;i++){ const x=(rnd()-.5)*W*.98, z=(rnd()-.5)*W*.98, h=.7+rnd()*1.1, wd=.9+rnd()*.8;
    q.setFromAxisAngle(up,rnd()*6.28); m.compose(p.set(x,H(x,z),z),q,s.set(wd,h,wd)); grass.setMatrixAt(i,m); rand[i]=rnd(); }
  bladeGeo.setAttribute('aRand',new THREE.InstancedBufferAttribute(rand,1)); }
grass.frustumCulled=false; scene.add(grass);

/* petal geometry (cupped, shaded base to tip) */
const petalGeo = (() => {
  const s=new THREE.Shape(); s.moveTo(0,0); s.bezierCurveTo(.24,.15,.22,.6,0,.8); s.bezierCurveTo(-.22,.6,-.24,.15,0,0);
  const g=new THREE.ShapeGeometry(s,6), p=g.attributes.position, c=[];
  for(let i=0;i<p.count;i++){ const x=p.getX(i), t=p.getY(i)/.8, v=.6+.4*t; p.setZ(i,x*x*1.4); c.push(v,v,v); }
  g.setAttribute('color',new THREE.Float32BufferAttribute(c,3)); g.computeBoundingSphere(); return g;
})();
const petalMat = new THREE.MeshBasicMaterial({vertexColors:true, side:THREE.DoubleSide});

/* flowers: clustered buds across the hills */
const palette = [0xf7a6b8,0xff8a6b,0xc8a2f0,0xffd166,0xfdf0f4,0xff6f91,0x9fd3ff,0xffb4a2].map(c=>new THREE.Color(c));
const flowers = [];
const clusters = [[0,30]];
while(clusters.length<11){ const a=rnd()*6.28, r=25+rnd()*65; clusters.push([Math.cos(a)*r, Math.sin(a)*r]); }
clusters.forEach(([cx,cz],ci)=>{ const col=palette[ci%palette.length], n=ci===0?5:6;
  for(let k=0;k<n;k++){ const a=rnd()*6.28, r=1.5+rnd()*6, x=cx+Math.cos(a)*r, z=cz+Math.sin(a)*r;
    flowers.push({x,z,y:H(x,z),h:1.1+rnd()*.9,ph:rnd()*6.28,col:col.clone().offsetHSL((rnd()-.5)*.04,0,(rnd()-.5)*.06),
      open:false,b:0,head:new THREE.Vector3()}); } });
const N = flowers.length; document.getElementById('n').textContent = N;

const stemGeo = new THREE.CylinderGeometry(.035,.055,1,5); stemGeo.translate(0,.5,0);
const stems = new THREE.InstancedMesh(stemGeo, new THREE.MeshBasicMaterial({color:0x4f6b48}), N);
const buds = new THREE.InstancedMesh(petalGeo, petalMat, N*6);
const cores = new THREE.InstancedMesh(new THREE.SphereGeometry(.13,8,6), new THREE.MeshBasicMaterial({color:0xffe08a}), N);
const closedCol = new THREE.Color(0xe9e3dc), tmpC = new THREE.Color();
const M=new THREE.Matrix4(), Q=new THREE.Quaternion(), E=new THREE.Euler(), S=new THREE.Vector3(), P=new THREE.Vector3();
flowers.forEach((f,i)=>{ M.compose(P.set(f.x,f.y,f.z),Q.identity(),S.set(1,f.h,1)); stems.setMatrixAt(i,M);
  for(let j=0;j<6;j++) buds.setColorAt(i*6+j,closedCol); });
[stems,buds,cores].forEach(m=>{m.frustumCulled=false; scene.add(m);});

/* the gust: a ribbon of petals behind the leader */
const MAXP = N+1;
const swarm = new THREE.InstancedMesh(petalGeo, petalMat, MAXP); swarm.frustumCulled=false; scene.add(swarm);
const leader = new THREE.Vector3(0, H(0,62)+3, 62);
const petals = [{pos:leader.clone(), col:new THREE.Color(0xfff1f4)}];
swarm.setColorAt(0, petals[0].col); swarm.count = 1;
paint(0,58,7,.55);

/* input */
let px=0, py=0, holding=false, keys={}, yaw=0, speed=2, touched=false;
const hint=document.getElementById('hint');
function pt(e){ px=e.clientX/innerWidth*2-1; py=e.clientY/innerHeight*2-1; }
renderer.domElement.addEventListener('pointermove',pt);
renderer.domElement.addEventListener('pointerdown',e=>{ pt(e); holding=true; wake(); });
addEventListener('pointerup',()=>holding=false); addEventListener('pointercancel',()=>holding=false);
addEventListener('keydown',e=>{ keys[e.key]=true; if([' ','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)){ e.preventDefault(); wake(); } });
addEventListener('keyup',e=>keys[e.key]=false);
function wake(){ if(!touched){ touched=true; setTimeout(()=>hint.classList.add('gone'),2500); } audioInit(); }

/* sound: pentatonic chime per bloom */
let ac=null, soundOn=true; const snd=document.getElementById('snd');
function audioInit(){ if(ac||!soundOn) return; try{ ac=new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} }
snd.addEventListener('click',()=>{ soundOn=!soundOn; snd.textContent=soundOn?'Sound on':'Sound off'; snd.setAttribute('aria-pressed',soundOn); if(soundOn) audioInit(); });
const scale=[0,2,4,7,9,12,14,16,19,21];
function chime(n){ if(!ac||!soundOn) return; const t=ac.currentTime, f=392*Math.pow(2,scale[n%scale.length]/12);
  [[1,.12],[2,.035],[3.01,.015]].forEach(([m,v])=>{ const o=ac.createOscillator(), g=ac.createGain();
    o.type='sine'; o.frequency.value=f*m; g.gain.setValueAtTime(.0001,t); g.gain.exponentialRampToValueAtTime(v,t+.02);
    g.gain.exponentialRampToValueAtTime(.0001,t+2.2); o.connect(g).connect(ac.destination); o.start(t); o.stop(t+2.3); }); }

/* frame */
const dusk={top:new THREE.Color(.27,.32,.47),hor:new THREE.Color(.86,.62,.52)};
const day ={top:new THREE.Color(.36,.58,.86),hor:new THREE.Color(1,.86,.68)};
let opened=0, prog=0, last=performance.now(), time=0;
const fwd=new THREE.Vector3(), camT=new THREE.Vector3(), look=new THREE.Vector3(), lookS=new THREE.Vector3(), sw=new THREE.Vector3();
const ease=t=>1-Math.pow(1-t,3);
camera.position.set(0,H(0,72)+6,72);

function resize(){ renderer.setSize(innerWidth,innerHeight,false); camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix(); }
addEventListener('resize',resize); resize();

function frame(now){
  const dt=Math.min((now-last)/1000,.05); last=now; time+=dt; U.uTime.value=time;

  // steering
  let sx=px, sy=py, go=holding;
  if(keys.ArrowLeft||keys.a) sx=-.7; if(keys.ArrowRight||keys.d) sx=.7;
  if(keys.ArrowUp||keys.w||keys[' ']) { go=true; if(!holding&&!keys.ArrowLeft&&!keys.ArrowRight&&!keys.a&&!keys.d) sx=0; }
  if(keys.ArrowDown||keys.s) sy=.6;
  yaw -= sx*Math.abs(sx)*1.9*dt*(go?1:.5);
  const r=Math.hypot(leader.x,leader.z);
  if(r>92){ const want=Math.atan2(leader.x,leader.z); let d=want-yaw; d=Math.atan2(Math.sin(d),Math.cos(d)); yaw+=d*Math.min(1,(r-92)*.06)*dt*3; }
  speed += ((go?14:2.2)-speed)*Math.min(1,dt*(go?1.6:1));
  fwd.set(-Math.sin(yaw),0,-Math.cos(yaw));
  leader.addScaledVector(fwd,speed*dt);
  const ground=H(leader.x,leader.z), alt=Math.max(ground+1.3, ground+3-sy*(touched?3.5:0)+Math.sin(time*.9)*.4);
  leader.y += (alt-leader.y)*Math.min(1,dt*2.5);
  U.uLeader.value.copy(leader);

  // camera
  camT.copy(leader).addScaledVector(fwd,-8.5); camT.y=Math.max(leader.y+3.2, H(camT.x,camT.z)+1.8);
  camera.position.lerp(camT,1-Math.exp(-dt*3));
  look.copy(leader).addScaledVector(fwd,4); look.y+=.4;
  lookS.lerp(look,1-Math.exp(-dt*5)); if(time<.1) lookS.copy(look);
  camera.lookAt(lookS); sky.position.copy(camera.position);

  // swarm
  petals[0].pos.copy(leader);
  for(let i=1;i<petals.length;i++){ const p=petals[i];
    sw.set(Math.sin(time*2.1+i*1.7),Math.cos(time*1.7+i*1.3)*.6,Math.sin(time*2.4+i*.7)).multiplyScalar(.45);
    camT.copy(petals[i-1].pos).add(sw); p.pos.lerp(camT,1-Math.exp(-dt*7)); }
  petals.forEach((p,i)=>{ E.set(time*2.3+i,time*1.4+i*.8,time*.7, 'XYZ'); Q.setFromEuler(E);
    M.compose(p.pos,Q,S.setScalar(i===0?.7:.55)); swarm.setMatrixAt(i,M); });
  swarm.instanceMatrix.needsUpdate=true;

  // flowers
  let colorDirty=false;
  flowers.forEach((f,i)=>{
    const a=reduced?0:.07;
    f.head.set(f.x+Math.sin(time*1.3+f.ph)*a*f.h, f.y+f.h+.05, f.z+Math.cos(time*1.1+f.ph)*a*f.h);
    if(!f.open && leader.distanceTo(f.head)<3.6){
      f.open=true; opened++; chime(opened-1);
      document.getElementById('c').textContent=opened;
      if(petals.length<MAXP){ const p={pos:f.head.clone(),col:f.col}; petals.push(p); swarm.setColorAt(petals.length-1,f.col); swarm.count=petals.length; swarm.instanceColor.needsUpdate=true; }
      if(opened===N) document.getElementById('end').hidden=false;
    }
    if(f.open && f.b<1){ f.b=Math.min(1,f.b+dt/1.5); paint(f.x,f.z,4+15*ease(f.b),.05); colorDirty=true;
      tmpC.copy(closedCol).lerp(f.col,ease(f.b)); for(let j=0;j<6;j++) buds.setColorAt(i*6+j,tmpC); }
    const k=ease(f.b), ang=-.22+1.4*k, s=.7+.5*k;
    for(let j=0;j<6;j++){ E.set(ang,j*Math.PI/3+f.ph,0,'YXZ'); Q.setFromEuler(E); M.compose(f.head,Q,S.setScalar(s)); buds.setMatrixAt(i*6+j,M); }
    M.compose(f.head,Q.identity(),S.setScalar(k)); cores.setMatrixAt(i,M);
  });
  buds.instanceMatrix.needsUpdate=true; cores.instanceMatrix.needsUpdate=true;
  if(colorDirty) buds.instanceColor.needsUpdate=true;

  // sky warms as the meadow wakes
  prog += (opened/N-prog)*Math.min(1,dt*.8);
  skyTop.copy(dusk.top).lerp(day.top,prog); skyHor.copy(dusk.hor).lerp(day.hor,prog);
  fogCol.copy(skyHor).lerp(skyTop,.25);

  renderer.render(scene,camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
})();
