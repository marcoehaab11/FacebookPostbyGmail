let csrf='';
const form=document.querySelector('#login-form'),error=document.querySelector('#login-error');
fetch('/api/auth/session').then(r=>r.json()).then(s=>{csrf=s.csrf;if(s.loggedIn)location.replace('/');}).catch(()=>{error.textContent='تعذر الاتصال. حدّث الصفحة.';error.classList.remove('hidden');});
form.onsubmit=async e=>{
  e.preventDefault();const button=form.querySelector('button');button.disabled=true;error.classList.add('hidden');
  try{
    if(!csrf)throw new Error('حدّث الصفحة وحاول مرة أخرى.');
    const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(Object.fromEntries(new FormData(form)))});
    const data=await r.json();if(!r.ok)throw new Error(data.error || 'تعذر تسجيل الدخول.');
    form.elements.password.value='';location.replace('/');
  }catch(e){error.textContent=e.message;error.classList.remove('hidden');}finally{button.disabled=false;}
};
