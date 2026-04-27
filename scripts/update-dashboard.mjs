import{io}from'socket.io-client';
const RF=process.env.CONTROLLE_REFRESH_TOKEN,GT=process.env.GH_TOKEN||process.env.GITHUB_TOKEN;
const API='https://controlle-api-prod.controlle.com',OWN='nilzonspinola-lang',REPO='gti-dashboard',CID=105337,CUID='c2712324-36fe-44d1-a466-afa0cddc0fcb';

async function renovar(){
  for(const ep of['/auth/refresh','/auth/refresh-token','/sessions/refresh','/users/refresh-token']){
    try{const r=await fetch(API+ep,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refreshToken:RF})});
    if(r.ok){const d=await r.json(),t=d.accessToken||d.access_token||d.token;if(t){console.log('Token renovado via',ep);return t;}}}catch(e){}
  }throw new Error('Falha ao renovar token');
}

async function saldos(token){
  return new Promise(res=>{
    const data={saldo_total:null,contas:[]};
    const s=io(API,{auth:{token},transports:['polling','websocket'],reconnection:false,timeout:15000,extraHeaders:{Authorization:'Bearer '+token}});
    const fim=()=>{s.disconnect();res(data);};
    const t=setTimeout(fim,20000);
    s.on('connect',()=>{console.log('Socket conectado');s.emit('generalBalance',{companyId:CID});s.emit('getGeneralBalance',{companyId:CID,companyUuid:CUID});s.emit('getAccounts',{companyId:CID});});
    s.on('connect_error',e=>{console.warn('Socket erro:',e.message);clearTimeout(t);fim();});
    s.onAny((ev,...args)=>{
      console.log('Evento:',ev,JSON.stringify(args).substring(0,150));
      try{const d=args[0];if(!d)return;
        const gb=d?.balances?.generalBalance??d?.generalBalance??d?.balance;
        if(typeof gb==='number'&&data.saldo_total===null){data.saldo_total=gb/100;console.log('Saldo geral: R$',data.saldo_total);}
        const cs=d?.accounts??d?.data??(Array.isArray(d)?d:null);
        if(Array.isArray(cs)&&cs.length>0&&cs[0]?.descriptionAccount){
          data.contas=cs.filter(c=>c.status===1&&!c.disabled).map(c=>({nome:c.descriptionAccount,saldo:(c.balance??0)/100}));
          console.log('Contas:',data.contas.length);
          if(data.saldo_total===null)data.saldo_total=data.contas.reduce((s,c)=>s+c.saldo,0);
          clearTimeout(t);setTimeout(fim,1000);}
      }catch(e){}});
  });
}

async function getHtml(){
  const r=await fetch(`https://api.github.com/repos/${OWN}/${REPO}/contents/index.html`,{headers:{Authorization:'token '+GT,Accept:'application/vnd.github.v3+json'}});
  const d=await r.json();
  const bytes=Uint8Array.from(atob(d.content.replace(/\n/g,'')),c=>c.charCodeAt(0));
  return{html:new TextDecoder('utf-8').decode(bytes),sha:d.sha};
}

function update(html,sd){
  const hoje=new Date(),dd=String(hoje.getUTCDate()).padStart(2,'0'),mm=String(hoje.getUTCMonth()+1).padStart(2,'0'),aaaa=hoje.getUTCFullYear();
  const meses=['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'],mn=meses[hoje.getUTCMonth()];
  const d7=new Date(hoje);d7.setUTCDate(d7.getUTCDate()-6);const d7d=String(d7.getUTCDate()).padStart(2,'0'),d7m=meses[d7.getUTCMonth()];
  let h=html;
  h=h.replace(/Atualizado \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}/g,`Atualizado ${dd}/${mm}/${aaaa} às 07:52`);
  h=h.replace(/Posi[çc][aã]o: \d{2}\/\d{2}\/\d{4}/g,`Posição: ${dd}/${mm}/${aaaa}`);
  h=h.replace(/\d{1,2} a \d{1,2} \w{3}\/\d{4}/g,`${d7d} a ${dd} ${mn}/${aaaa}`);
  h=h.replace(/\d{1,2}-\d{1,2}\/[a-z]{3}\/\d{4}/gi,`${d7d}-${dd}/${mn.toLowerCase()}/${aaaa}`);
  if(sd.contas.length>=5){
    const mp={itaú:0,ita:0,nordeste:1,bnb:1,caixa:2,sicoob:3,santander:4},vs=[0,0,0,0,0];
    for(const c of sd.contas){const n=c.nome.toLowerCase();for(const[k,i]of Object.entries(mp))if(n.includes(k)){vs[i]=c.saldo;break;}}
    const nd=vs.join(',');
    h=h.replace(/(\[)([\-\d.]+,[\-\d.]+,[\-\d.]+,[\-\d.]+,[\-\d.]+)(\])/g,(m,a,d,b)=>{
      const ns=d.split(',').map(Number);return ns.some(n=>Math.abs(n)>100&&Math.abs(n)<1e7)?a+nd+b:m;});
    console.log('Grafico:',nd);}
  return h;
}

async function push(html,sha){
  const hoje=new Date(),dd=String(hoje.getUTCDate()).padStart(2,'0'),mm=String(hoje.getUTCMonth()+1).padStart(2,'0'),aaaa=hoje.getUTCFullYear();
  const r=await fetch(`https://api.github.com/repos/${OWN}/${REPO}/contents/index.html`,{
    method:'PUT',headers:{Authorization:'token '+GT,'Content-Type':'application/json',Accept:'application/vnd.github.v3+json'},
    body:JSON.stringify({message:`chore: atualiza dashboard ${dd}/${mm}/${aaaa} 07:52`,content:btoa(unescape(encodeURIComponent(html))),sha,branch:'main'})});
  const d=await r.json();
  if(!r.ok)throw new Error('GitHub '+r.status+': '+JSON.stringify(d));
  console.log('Publicado! Commit:',d.commit?.sha?.substring(0,8));
}

async function main(){
  console.log('GTI Dashboard — iniciando...');
  if(!RF)throw new Error('CONTROLLE_REFRESH_TOKEN nao definido');
  if(!GT)throw new Error('GH_TOKEN nao definido');
  let token;try{token=await renovar();}catch(e){console.warn('Sem token:',e.message);}
  let sd={saldo_total:null,contas:[]};
  if(token)try{sd=await saldos(token);}catch(e){console.warn('Sem saldos:',e.message);}
  const{html,sha}=await getHtml();
  const hu=update(html,sd);
  await push(hu,sha);
  console.log('Concluido!');
}
main().catch(e=>{console.error('Erro:',e.message);process.exit(1);});