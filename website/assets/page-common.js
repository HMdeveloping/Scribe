(function(){
  const sl=localStorage.getItem('scribe-language')==='sl';
  document.documentElement.lang=sl?'sl':'en';
  const text=(selector,value)=>document.querySelectorAll(selector).forEach(el=>el.textContent=value);
  text('.navlinks a[href*="#how"]',sl?'Kako deluje':'How it works');
  text('.navlinks a[href*="#local"]',sl?'Lokalno najprej':'Local first');
  text('.navbutton',sl?'Pridobi Scribe':'Get Scribe');
  document.querySelectorAll('.footer .contact').forEach(el=>el.innerHTML='<a href="contact.html">'+(sl?'Kontakt':'Contact')+'</a> · <a href="privacy.html">'+(sl?'Politika zasebnosti':'Privacy Policy')+'</a>');
  if(!document.querySelector('.language-picker')){const button=document.querySelector('.language-toggle');if(button){button.textContent=sl?'SL':'EN';button.onclick=()=>{localStorage.setItem('scribe-language',sl?'en':'sl');location.reload()}}}
})();
