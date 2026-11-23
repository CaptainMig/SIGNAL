// Minimal RFC 4180 CSV parser for history.csv: quoted fields, doubled quotes,
// CRLF or LF. Returns [{ column: value }] with numeric-looking values as
// numbers and empty fields as null. Pure; also used by the tests.
export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0];
  return nonEmpty.slice(1).map((r) => {
    const o = {};
    header.forEach((h, i) => {
      const v = r[i] ?? '';
      if (v === '') o[h] = null;
      else if (/^-?\d+(\.\d+)?$/.test(v)) o[h] = Number(v);
      else o[h] = v;
    });
    return o;
  });
}
