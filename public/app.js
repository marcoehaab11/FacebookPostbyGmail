const $=selector=>document.querySelector(selector);
const labels={scheduled:'مجدول',missed:'فات الموعد',pending:'بانتظار المراجعة',published:'تم النشر',failed:'فشل النشر',uncertain:'نتيجة غير مؤكدة',publishing:'جاري النشر',rejected:'مرفوض'};
let csrf='',settings={},posts=[],filter='pending',selected=null,previewUrl=null,toastTimer;
const escape=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(message,error=false){clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').className='toast'+(error?' error':'');toastTimer=setTimeout(()=>$('#toast').classList.add('hidden'),6500);}
async function api(path,{method='GET',body}={}) {
  const form=body instanceof FormData;
  const r=await fetch('/api'+path,{method,headers:{...(method!=='GET'?{'X-CSRF-Token':csrf}:{}),...(!form && body?{'Content-Type':'application/json'}:{})},...(body?{body:form?body:JSON.stringify(body)}:{})});
  const data=await r.json();if(!r.ok)throw new Error(data.error || 'تعذر تنفيذ العملية.');return data;
}
async function busy(button,work){const old=button.textContent;button.disabled=true;button.textContent='لحظة…';try{return await work();}catch(e){toast(e.message,true);return null;}finally{button.disabled=false;button.textContent=old;}}
function formatDate(value){return new Intl.DateTimeFormat('ar-EG',{dateStyle:'medium',timeStyle:'short',timeZone:'Africa/Cairo'}).format(new Date(value));}
function changeView(name){document.querySelectorAll('.view').forEach(v=>v.classList.toggle('hidden',v.id!==name+'-view'));document.querySelectorAll('.nav-item').forEach(v=>v.classList.toggle('active',v.dataset.view===name));if(name==='activity')loadActivity().catch(e=>toast(e.message,true));}
const attention=p=>!!p.issue || ['failed','uncertain','publishing','missed'].includes(p.status);
function renderPosts(){
  const pending=posts.filter(p=>p.status==='pending').length;
  $('#stat-pending').textContent=pending;$('#tab-pending').textContent=pending;$('#nav-count').textContent=pending;
  $('#stat-published').textContent=posts.filter(p=>p.status==='published').length;$('#stat-issues').textContent=posts.filter(attention).length;
  const term=$('#search').value.trim().toLowerCase();
  const visible=posts.filter(p=>(filter==='all' || (filter==='attention'?attention(p):p.status===filter)) && (p.caption+' '+p.theme).toLowerCase().includes(term));
  $('#collection-title').textContent=({scheduled:'بوستات مجدولة بتوقيت القاهرة',pending:'قائمة المراجعة',published:'بوستات وصلت للصفحة',attention:'محتوى يحتاج انتباهك',rejected:'بوستات مرفوضة',all:'كل البوستات'})[filter];
  $('#empty').classList.toggle('hidden',visible.length>0);
  $('#empty h2').textContent=posts.length?'مفيش بوستات في القائمة دي.':'مساحة لبوستك الجاي.';
  $('#post-grid').innerHTML=visible.map(p=>`<article class="post-card">${p.image?`<img class="post-image" src="/images/${escape(p.image)}" alt="${escape(p.theme || 'صورة البوست')}" loading="lazy">`:'<div class="missing-image">▧ صورة محتاجة إضافة</div>'}<div class="post-content"><div class="post-meta"><span class="badge ${attention(p)?'warning':p.status}">${escape(p.issue && p.status==='pending'?'الصورة تحتاج إصلاح':labels[p.status])}</span><span>${escape(p.date)} · #${escape(p.source_post_id)}</span></div><h3 dir="auto">${escape(p.theme || 'بوست NUVEXA')}</h3><p dir="auto">${escape(p.caption)}</p><div class="card-bottom"><small>${p.status==='scheduled'?'◷ '+formatDate(p.scheduled_at):p.image?'✓ صورة محفوظة':'○ صورة غير متاحة'}</small><button class="button secondary" data-review="${escape(p.id)}">${p.status==='published'?'عرض التفاصيل':'افتح المراجعة'} ←</button></div></div></article>`).join('');
}
function renderSettings(){
  const form=$('#settings-form');for(const name of ['mailbox','allowedSender','pageId','apiVersion','clientId'])form.elements[name].value=settings[name] || '';
  form.elements.autoSync.checked=settings.autoSync;
  for(const [name,has] of [['clientSecret','hasClientSecret'],['facebookToken','hasFacebookToken']]){form.elements[name].value='';form.elements[name].placeholder=settings[has]?'محفوظ — اتركه فارغًا للاحتفاظ به':'أدخل القيمة';}
  $('#redirect-uri').value=settings.redirectUri;$('#gmail-status').textContent=settings.connectedEmail?'متصل: '+settings.connectedEmail:'غير متصل';$('#facebook-status').textContent=settings.pageId && settings.hasFacebookToken?'بيانات محفوظة · Page '+settings.pageId:'بيانات الربط غير مكتملة';
  $('#connection-banner').classList.toggle('hidden',!!settings.connectedEmail && !!settings.pageId && settings.hasFacebookToken);
  $('#disconnect-google').disabled=!settings.connectedEmail;
}
async function refresh(){
  const b=await api('/bootstrap');csrf=b.csrf;settings=b.settings;
  $('#sync-status').textContent=b.sync.running?'جاري مزامنة الإيميلات…':b.sync.lastError || (b.sync.lastSync?'آخر مزامنة: '+formatDate(b.sync.lastSync):'لم تتم المزامنة بعد');
  posts=await api('/posts');renderPosts();
}
async function saveSettings(){const form=$('#settings-form'),b=Object.fromEntries(new FormData(form));b.autoSync=form.elements.autoSync.checked;settings=await api('/settings',{method:'POST',body:b});renderSettings();}
function openImport(){
  const date=new Date().toLocaleDateString('en-CA',{timeZone:'Africa/Cairo'});
  $('#import-payload').value=JSON.stringify({brand:'NUVEXA PROPERTIES',date,posts:[{post_id:Date.now(),theme:'عنوان البوست',caption:'اكتب الكابشن هنا…',image_url:''}]},null,2);$('#import-dialog').showModal();
}
function setPreview(){
  $('#preview-caption').textContent=$('#review-caption').value;$('#caption-count').textContent=$('#review-caption').value.length.toLocaleString('ar-EG')+' حرف';
  const file=$('#review-file').files[0];if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl=null;}
  if(file){previewUrl=URL.createObjectURL(file);$('#review-image').src=previewUrl;}else if(selected?.image)$('#review-image').src='/images/'+selected.image;else $('#review-image').removeAttribute('src');
  $('#review-image').classList.toggle('hidden',!file && !selected?.image);
}
function openReview(id){
  selected=posts.find(p=>p.id===id);if(!selected)return;
  const editable=['pending','failed','rejected','missed'].includes(selected.status);
  $('#review-form').reset();$('#review-title').textContent=selected.theme || 'مراجعة البوست';$('#review-caption').value=selected.caption;
  $('#review-caption').disabled=!editable;$('#review-file').disabled=!editable;$('#review-form').elements.imageUrl.disabled=!editable;$('#save-edit').classList.toggle('hidden',!editable);
  $('#review-issue').textContent=selected.issue || '';$('#review-issue').classList.toggle('hidden',!selected.issue);
  $('#review-actions').classList.toggle('hidden',!['pending','failed','missed'].includes(selected.status));
  $('#approve').disabled=!settings.pageId || !settings.hasFacebookToken || !selected.image || !!selected.issue;
  $('#schedule-panel').classList.toggle('hidden',!['pending','failed','missed'].includes(selected.status));
  $('#scheduled-info').classList.toggle('hidden',selected.status!=='scheduled');
  $('#scheduled-description').textContent=selected.scheduled_at?'موعد النشر: '+formatDate(selected.scheduled_at)+' بتوقيت القاهرة. للتعديل ألغِ الجدولة أولًا.':'';
  $('#schedule-post').disabled=$('#approve').disabled;
  $('#review-checks').innerHTML=`<span>${selected.image?'✓ الصورة اتفحصت واتحفظت محليًا':'○ أضف صورة صالحة قبل النشر'}</span><span>✓ الكلام موجود · راجعه بنفسك قبل الموافقة</span><span>${settings.pageId && settings.hasFacebookToken?'✓ صفحة النشر: '+escape(settings.pageId):'○ أكمل ربط Facebook من الإعدادات'}</span><span>✓ منع تكرار البوست مفعّل</span>`;
  $('#reconcile').classList.toggle('hidden',selected.status!=='uncertain');$('#photo-id').value='';
  $('#facebook-link').classList.toggle('hidden',selected.status!=='published');if(selected.status==='published')$('#facebook-link').href='https://www.facebook.com/'+encodeURIComponent(selected.facebook_post_id || selected.photo_id);
  setPreview();if(!$('#review-dialog').open)$('#review-dialog').showModal();
}
async function saveEdit(){const body=new FormData($('#review-form'));await api('/posts/'+selected.id,{method:'PATCH',body});const id=selected.id;await refresh();openReview(id);}
function confirmAction(title,message){return new Promise(resolve=>{const d=$('#confirm-dialog');$('#confirm-title').textContent=title;$('#confirm-message').textContent=message;const finish=value=>{d.close();$('#confirm-yes').onclick=null;$('#confirm-no').onclick=null;d.oncancel=null;resolve(value);};$('#confirm-yes').onclick=()=>finish(true);$('#confirm-no').onclick=()=>finish(false);d.oncancel=e=>{e.preventDefault();finish(false);};d.showModal();});}
async function loadActivity(){const data=await api('/events');$('#events').innerHTML=data.events.length?data.events.map(e=>`<div class="activity-row"><span>${escape(e.message)}</span><small>${formatDate(e.created_at)}</small></div>`).join(''):'<div class="activity-empty">مفيش نشاط مسجل لسه.</div>';$('#emails').innerHTML=data.emails.length?data.emails.map(e=>`<div class="activity-row"><span>${escape(({received:'تم الاستقبال',invalid:'تعذر قراءة الإيميل',ignored:'تم تجاهله'})[e.status])}${e.status==='invalid'?' · '+escape(e.message):''}</span><small>${formatDate(e.created_at)}</small></div>`).join(''):'<div class="activity-empty">الإيميلات هتظهر بعد أول مزامنة.</div>';}
document.addEventListener('click',e=>{
  const view=e.target.closest('[data-view]');if(view)changeView(view.dataset.view);
  const close=e.target.closest('[data-close]');if(close)$('#'+close.dataset.close).close();
  const tab=e.target.closest('[data-filter]');if(tab){filter=tab.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('selected',b===tab));renderPosts();}
  const card=e.target.closest('[data-review]');if(card)openReview(card.dataset.review);
});
$('#search').addEventListener('input',renderPosts);$('#open-import').onclick=openImport;$('#empty-import').onclick=openImport;
$('#sync').onclick=()=>busy($('#sync'),async()=>{const r=await api('/sync',{method:'POST',body:{}});toast(r.busy?'المزامنة شغالة بالفعل.':`وصل ${r.added} بوست جديد للمراجعة.`);await refresh();});
$('#settings-form').onsubmit=e=>{e.preventDefault();busy(e.submitter,async()=>{await saveSettings();toast('الإعدادات اتحفظت.');});};
$('#connect-google').onclick=()=>busy($('#connect-google'),async()=>{await saveSettings();const r=await api('/google/connect',{method:'POST',body:{}});window.location.assign(r.url);});
$('#disconnect-google').onclick=()=>busy($('#disconnect-google'),async()=>{await api('/google/disconnect',{method:'POST',body:{}});await refresh();renderSettings();toast('تم فصل Gmail محليًا.');});
$('#import-form').onsubmit=e=>{e.preventDefault();busy(e.submitter,async()=>{const r=await api('/import',{method:'POST',body:new FormData(e.target)});$('#import-dialog').close();toast(`تمت إضافة ${r.added} بوست. ${r.duplicates} مكرر، و${r.issues} يحتاج إصلاح صورة.`);await refresh();});};
$('#review-caption').addEventListener('input',setPreview);$('#review-file').addEventListener('change',setPreview);
$('#review-form').onsubmit=e=>{e.preventDefault();busy(e.submitter,async()=>{await saveEdit();toast('التعديلات اتحفظت. راجع المعاينة قبل النشر.');});};
$('#approve').onclick=()=>busy($('#approve'),async()=>{
  await saveEdit();
  $('#approve').disabled=true;
  if(!(await confirmAction('جاهز للنشر؟','هيتنشر البوست بالصورة والكلام الموجودين في المعاينة على صفحة '+settings.pageId+' فورًا.')))return;
  const id=selected.id;$('#reject').disabled=true;
  try{const r=await api('/posts/'+id+'/publish',{method:'POST',body:{approved:true}});toast(r.status==='published'?'البوست اتنشر بنجاح.':r.message,r.status!=='published');await refresh();openReview(id);}finally{$('#reject').disabled=false;}
});
$('#reject').onclick=()=>busy($('#reject'),async()=>{await api('/posts/'+selected.id+'/reject',{method:'POST',body:{}});$('#review-dialog').close();toast('تم رفض البوست. تقدر تعدّله وتعيده للمراجعة.');await refresh();});
async function reconcile(result){if(!(await confirmAction('تسجيل نتيجة المراجعة','تأكد إنك راجعت صفحة Facebook بنفسك. تسجيل عدم النشر يسمح بمحاولة نشر جديدة.')))return;await api('/posts/'+selected.id+'/reconcile',{method:'POST',body:{result,checked:true,photoId:$('#photo-id').value.trim()}});const id=selected.id;await refresh();openReview(id);toast('تم تسجيل نتيجة المراجعة.');}
$('#confirm-published').onclick=()=>busy($('#confirm-published'),()=>reconcile('published'));$('#confirm-not-published').onclick=()=>busy($('#confirm-not-published'),()=>reconcile('not_published'));
refresh().then(()=>{renderSettings();const params=new URLSearchParams(location.search);if(params.get('gmail')){toast(params.get('gmail')==='connected'?'تم ربط Gmail بنجاح.':'تعذر ربط Gmail. تحقق من بيانات Google والحساب المختار.',params.get('gmail')!=='connected');history.replaceState({},'',location.pathname);changeView('settings');}}).catch(e=>toast(e.message,true));
setInterval(()=>refresh().catch(()=>{}),30000);

$('#suggest-time').onclick=()=>{
  // Compare Cairo wall-clock values; never depend on the computer's timezone.
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(Date.now()+60000)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
  let day=`${parts.year}-${parts.month}-${parts.day}`;
  if(Number(parts.hour)>=20){const next=new Date(day+'T12:00:00Z');next.setUTCDate(next.getUTCDate()+1);day=next.toISOString().slice(0,10);}
  $('#schedule-time').value=day+'T20:00';
  toast('اخترنا أقرب ٨ مساءً بتوقيت القاهرة. اضغط «وافق وجدول» لتأكيد الموعد.');
};
$('#schedule-post').onclick=()=>busy($('#schedule-post'),async()=>{
  const localTime=$('#schedule-time').value;
  if(!localTime)throw new Error('اختار تاريخ ووقت النشر.');
  await saveEdit();$('#schedule-time').value=localTime;
  if(!(await confirmAction('تأكيد الجدولة','هيتنشر البوست تلقائيًا يوم '+localTime.replace('T',' الساعة ')+' بتوقيت القاهرة على صفحة '+settings.pageId+'. خلي الجهاز والبرنامج شغالين.')))return;
  const id=selected.id;await api('/posts/'+id+'/schedule',{method:'POST',body:{approved:true,localTime}});
  await refresh();openReview(id);toast('تمت جدولة البوست بتوقيت القاهرة.');
});
$('#cancel-schedule').onclick=()=>busy($('#cancel-schedule'),async()=>{
  const id=selected.id;await api('/posts/'+id+'/cancel-schedule',{method:'POST',body:{}});await refresh();openReview(id);toast('اتلغت الجدولة. تقدر تعدّل وتختار موعد جديد.');
});
