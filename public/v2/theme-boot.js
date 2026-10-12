(function(){
  try{var t=localStorage.getItem('ao.uiTheme');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t;}catch(e){}
  var u='owner';try{u=localStorage.getItem('ao.identity.lastUser')||u;}catch(e){}
  function apply(){
    var i='bureau';try{i=localStorage.getItem('ao.identity.user.'+encodeURIComponent(u))||i;localStorage.setItem('ao.identity.lastUser',u);}catch(e){}
    if(!/^[a-z][a-z0-9-]*$/.test(i))i='bureau';
    document.documentElement.dataset.identity=i;
    var l=document.getElementById('ao-identity-theme')||document.head.appendChild(Object.assign(document.createElement('link'),{id:'ao-identity-theme',rel:'stylesheet'}));
    l.href='identity-themes/'+i+'/theme.css?v='+document.querySelector('meta[name="ao-build"]').content;
    window.dispatchEvent(new Event('ao-identity-theme-change'));
  }
  window.AO_SYNC_IDENTITY=m=>{u=m?.id??m?.email?.trim().toLowerCase()??u;apply()};
  apply();
})();
