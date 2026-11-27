export function noteRows(byPage) {
  return [...byPage.entries()].sort(([a],[b])=>a-b).flatMap(([page,notes])=>
    notes.filter(note=>note.type==='note').map(note=>({
      page, id:note.id, at:note.at, text:note.text
    }))
  );
}

export function notesText(title, rows) {
  return [title,...rows.map(note=>note.page+'ページ\n'+note.text)].join('\n\n')+'\n';
}

export function saveTextNotes(title, rows) {
  const filename = title.replace(/\.[^.]+$/,'').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_')
    .trim().slice(0,100) || '本';
  const contents = notesText(title,rows).replace(/\r\n?|\n/g,'\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF',contents],{type:'text/plain;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename+'のメモ.txt';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60_000);
}

export function paintPrintNotes(container, title, rows) {
  const heading = document.createElement('h1');
  heading.textContent = title+'のメモ';
  const content = document.createDocumentFragment();
  content.append(heading);
  for (const note of rows) {
    const label = document.createElement('h2');
    label.textContent = note.page+'ページ';
    const text = document.createElement('p');
    text.textContent = note.text;
    content.append(label,text);
  }
  container.replaceChildren(content);
}
