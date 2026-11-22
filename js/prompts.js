(function(){
  let flow=null;
  const esc=CSCatalog.esc;
  const questionTypes=new Set(['single_choice','multiple_choice','numeric','formula','reaction_products','sequence','matching']);

  async function start(kind,topicId){
    const launchHash=location.hash,topic=await CSDB.get('topics',topicId);
    if(location.hash!==launchHash)return;
    if(!topic)return CSToast('Тема не найдена');
    const allNotes=await CSDB.all('topic_contents');
    const notes=allNotes.filter(x=>x.topic_id===topicId&&(x.status==='published'||x.status==='draft')).sort((a,b)=>b.version-a.version);
    if(kind==='conspect'&&allNotes.some(x=>x.topic_id===topicId&&x.status==='published'))return CSToast('Опубликованный конспект уже есть. Откройте тему.');
    if(kind==='tasks'||kind==='test'){
      if(!notes.length)return CSToast('Сначала сохраните версию конспекта.');
      flow={topic,kind,note:notes[0],launchHash};
    }else flow={topic,kind,note:null,launchHash};
    await render();
  }

  async function render(){
    const kind=flow.kind;
    const name=kind==='conspect'?'PROMPT_CONSPECT':kind==='tasks'?'PROMPT_TASKS':'PROMPT_TEST';
    const [template,sourceSetting,categories]=await Promise.all([CSDB.get('prompt_templates',name),CSDB.get('app_settings','default_sources'),CSDB.all('categories')]);
    if(location.hash!==flow.launchHash)return;
    const categoryName=categories.find(x=>x.id===flow.topic.category_id)?.name||flow.topic.category||'Химия';
    const sources=(sourceSetting?.value||CSDB.DEFAULT_SOURCES).map(x=>({...x,status:'not_verified',note:'Указан URL; содержимое источника не получено.'}));
    const sections=flow.note?.content?.sections||[];
    const prompt=(template?.body||'').replaceAll('{{topic}}',flow.topic.title).replaceAll('{{category}}',categoryName).replaceAll('{{sources}}',JSON.stringify(sources,null,2)).replaceAll('{{version}}',flow.note?.version||'создаваемая').replaceAll('{{sections}}',JSON.stringify(sections.map(s=>({id:s.id,title:s.title})),null,2));
    window.CSPrompts.prompt=prompt;
    document.querySelector('#app').innerHTML=`<button class="button ghost small" onclick="CSRouter.go('catalog')">← Назад в каталог</button><h1 style="margin-top:20px">Ручная генерация</h1><p class="muted">${esc(flow.topic.title)} · ${esc(template?.title||kind)}${flow.note?` · конспект v${flow.note.version}`:''}</p><div class="notice">Скопируйте промт во внешнюю модель, затем вставьте сюда её JSON-ответ. Приложение ничего не отправляет во внешние сервисы. Проверка структуры не подтверждает химическую корректность.</div><div class="field" style="margin-top:18px"><label>Готовый промт</label><textarea id="prompt-text" class="mono" rows="12">${esc(prompt)}</textarea></div><div class="card-actions"><button class="button secondary" onclick="CSPrompts.copy()">Скопировать промт</button></div><div class="field" style="margin-top:20px"><label>Ответ внешней модели (JSON)</label><textarea id="answer-json" class="mono" rows="12" placeholder="Вставьте JSON…"></textarea></div><div class="row"><button class="button" onclick="CSPrompts.validate()">Проверить ответ</button><button class="button ghost" onclick="CSPrompts.clear()">Очистить</button><button class="button ghost" onclick="CSRouter.go('catalog')">Назад</button></div><div id="validation"></div><div id="generated-preview"></div>`;
  }

  async function copy(){const text=document.querySelector('#prompt-text').value;try{await navigator.clipboard.writeText(text)}catch{const el=document.querySelector('#prompt-text');el.select();document.execCommand('copy')}CSToast('Промт скопирован')}
  function clear(){document.querySelector('#answer-json').value='';document.querySelector('#validation').innerHTML='';document.querySelector('#generated-preview').innerHTML='';window.CSPrompts.checked=null}

  function validate(){
    const raw=document.querySelector('#answer-json').value;let value;
    try{value=JSON.parse(raw)}catch(e){document.querySelector('#validation').innerHTML=`<div class="error">Некорректный JSON: ${esc(e.message)}. Проверьте кавычки, запятые и скобки.</div>`;return}
    const errors=[],f=flow;
    if(!value||value.schema_version!==1)errors.push('schema_version должен быть равен 1.');
    if(f.kind==='conspect')errors.push(...CSEditor.validateNote(value));
    if(f.kind==='tasks')errors.push(...CSTasks.validate(value.tasks,new Set(f.note.content.sections.map(s=>s.id))));
    if(f.kind==='test'){
      if(!Array.isArray(value.questions)||!value.questions.length)errors.push('Нужен непустой массив questions.');
      const allowed=new Set(f.note.content.sections.map(s=>s.id)),ids=new Set();
      (value.questions||[]).forEach((q,i)=>{
        if(!q.id)errors.push(`Вопрос ${i+1}: отсутствует ID.`);
        if(ids.has(q.id))errors.push(`Вопрос ${i+1}: ID повторяется.`);ids.add(q.id);
        if(!questionTypes.has(q.type))errors.push(`Вопрос ${i+1}: неподдерживаемый тип ${q.type}.`);
        if(!q.prompt)errors.push(`Вопрос ${i+1}: отсутствует формулировка.`);
        if(!q.explanation)errors.push(`Вопрос ${i+1}: отсутствует объяснение.`);
        if(!Array.isArray(q.related_sections)||!q.related_sections.length)errors.push(`Вопрос ${i+1}: добавьте related_sections.`);
        (q.related_sections||[]).forEach(id=>{if(!allowed.has(id))errors.push(`Вопрос ${i+1}: неизвестный раздел ${id}.`)});
        if(['single_choice','multiple_choice','reaction_products'].includes(q.type)&&(!Array.isArray(q.options)||q.options.length<2))errors.push(`Вопрос ${i+1}: добавьте не менее двух вариантов.`);
        if(q.type==='single_choice'&&(!Array.isArray(q.options)||!Number.isInteger(q.correct_answer)||q.correct_answer<0||q.correct_answer>=q.options.length))errors.push(`Вопрос ${i+1}: correct_answer должен быть индексом варианта.`);
        if(['multiple_choice','reaction_products'].includes(q.type)&&(!Array.isArray(q.correct_answer)||!q.correct_answer.length||q.correct_answer.some(n=>!Number.isInteger(n)||n<0||n>=q.options.length)))errors.push(`Вопрос ${i+1}: проверьте индексы правильных вариантов.`);
        if(q.type==='numeric'&&typeof q.correct_answer!=='number')errors.push(`Вопрос ${i+1}: правильный числовой ответ должен быть числом.`);
        if(q.type==='formula'&&typeof q.correct_answer!=='string')errors.push(`Вопрос ${i+1}: правильный ответ с формулой должен быть строкой.`);
        if(q.type==='sequence'&&!Array.isArray(q.correct_answer))errors.push(`Вопрос ${i+1}: правильная последовательность должна быть массивом.`);
        if(q.type==='matching'&&(!q.correct_answer||typeof q.correct_answer!=='object'||Array.isArray(q.correct_answer)))errors.push(`Вопрос ${i+1}: ответ matching должен быть JSON-объектом.`);
      });
    }
    if(errors.length){document.querySelector('#validation').innerHTML=`<div class="error">${errors.map(esc).join('<br>')}</div>`;document.querySelector('#generated-preview').innerHTML='';return}
    window.CSPrompts.checked=value;
    document.querySelector('#validation').innerHTML='<div class="success notice">Структура данных и ссылки проверены. Перед публикацией проверьте химию вручную.</div>';
    document.querySelector('#generated-preview').innerHTML=`<h2>Предпросмотр</h2><div class="preview">${f.kind==='conspect'?value.sections.map(s=>`<section class="section"><h3>${esc(s.title)}</h3>${s.blocks.map(CSTopics.renderBlock).join('')}</section>`).join(''):f.kind==='tasks'?value.tasks.map(t=>`<article class="task-card"><span class="tag">${esc(t.difficulty)}</span><h3>${esc(t.title)}</h3><p>${esc(t.condition)}</p><ol>${t.steps.map(x=>`<li>${esc(x)}</li>`).join('')}</ol><b>${esc(t.answer)}</b></article>`).join(''):value.questions.map(q=>`<article class="question-card"><h3>${esc(q.prompt)}</h3><p>${(q.options||[]).map(esc).join(' · ')}</p><p>Разделы: ${q.related_sections.map(esc).join(', ')}</p></article>`).join('')}</div><button class="button" style="margin-top:12px" onclick="CSPrompts.save()">Сохранить черновик</button>`;
  }

  async function save(){
    const f=flow,value=window.CSPrompts.checked;if(!value)return;
    let store,content;
    if(f.kind==='conspect'){store='topic_contents';content=value}
    else if(f.kind==='tasks'){store='task_sets';content={schema_version:1,content_version_id:f.note.id,tasks:value.tasks}}
    else{store='topic_tests';content={schema_version:1,content_version_id:f.note.id,questions:value.questions}}
    const saved=await CSEditor.saveMaterial(store,f.topic.id,content);
    if(location.hash!==f.launchHash){CSToast('Черновик сохранён');return}
    CSToast(`Черновик v${saved.version} сохранён`);
    if(f.kind==='conspect'){await start('tasks',f.topic.id);CSToast('Конспект сохранён. Теперь можно создать задачи или тест на его основе.')}
    else CSRouter.go('admin');
  }
  window.CSPrompts={start,render,copy,clear,validate,save,flow:null,prompt:'',checked:null};
})();
