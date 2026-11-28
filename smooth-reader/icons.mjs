const paths = {
  shelf:'<path d="M4 4h4v15H4zM10 4h4v15h-4zM16 5l3.5-1 4 14-3.5 1zM2 21h20"/>',
  plus:'<path d="M12 5v14M5 12h14"/>', minus:'<path d="M5 12h14"/>',
  left:'<path d="m15 5-7 7 7 7"/>', right:'<path d="m9 5 7 7-7 7"/>',
  track:'<path d="M3 7h18M3 17h18"/><rect x="2" y="9.5" width="20" height="5" rx="1"/>',
  mark:'<path d="m8 16-4-4L15 2l5 5L10 17zm0 0-5 4h8l2-2M3 22h14"/>',
  erase:'<path d="m4 11 8-8a2 2 0 0 1 3 0l6 6a2 2 0 0 1 0 3l-8 8H9l-5-5a3 3 0 0 1 0-4zm4-4 9 9m-4 4h9"/>',
  note:'<path d="M4 4h16v11l-5 5H4zm11 16v-5h5M8 9h8m-8 4h5"/>',
  lasso:'<path d="M6 15c-3-1-4-3-3-6 1-4 6-6 11-5 4 1 7 3 7 6s-4 6-9 6c-2 0-4-1-4-3s3-3 5-2c3 2 0 8-4 9-2 1-4 0-5-1"/>',
  settings:'<path d="M3 6h18M3 12h18M3 18h18"/><circle fill="white" cx="8" cy="6" r="2"/><circle fill="white" cx="16" cy="12" r="2"/><circle fill="white" cx="10" cy="18" r="2"/>',
  move:'<path d="M12 2v20M2 12h20M9 5l3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3M19 9l3 3-3 3"/>',
  eye:'<path d="M2 12s3-6 10-6 10 6 10 6-3 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>',
  eyeOff:'<path d="m4 4 16 16M3 12s3-6 9-6c6 0 9 6 9 6s-1 2-3 3.5M14 18c-1 .3-1.5.3-2 .3C6 18.3 3 12 3 12"/>',
  undo:'<path d="m9 4-6 6 6 6m-6-6h12a6 6 0 0 1 0 12"/>',
  redo:'<path d="m15 4 6 6-6 6m6-6H9a6 6 0 0 0 0 12"/>',
  rotate:'<path d="M20 10a8 8 0 1 1-3-5.5L20 7m0-5v5h-5"/>',
  close:'<path d="m5 5 14 14M19 5 5 19"/>',
  bar:'<rect x="3" y="9" width="18" height="6" rx="2" fill="#77c8bc"/>',
  window:'<path d="M3 7h18v3H3zm0 7h18v3H3z" fill="#77c8bc"/>',
  line:'<path d="M3 15h18" stroke-width="3"/>',
  lens:'<rect x="3" y="8" width="18" height="8" rx="4"/><path d="M10 12h4m-2-2v4"/>',
  file:'<path d="M5 3h9l5 5v13H5zm9 0v5h5M8 13h8m-8 4h6"/>',
  list:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m3-10h6m-6 4h6"/>',
  trash:'<path d="M4 6h16M9 6V3h6v3m3 0-1 15H7L6 6m4 4v7m4-7v7"/>'
};
export function icon(name) {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + paths[name] + '</svg>';
}
