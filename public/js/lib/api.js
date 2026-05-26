async function req(method, path, body) {
  const opts = {
    method,
    credentials: 'same-origin',
    headers: { 'accept': 'application/json' },
  };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

export const api = {
  get:    (p) => req('GET', p),
  post:   (p, b) => req('POST', p, b),
  patch:  (p, b) => req('PATCH', p, b),
  del:    (p) => req('DELETE', p),
};
