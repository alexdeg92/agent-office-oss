// Transport only. Floor projection, default generation, validation and merging belong to the API.
export function layoutLocation(id = null) {
  const query = id == null ? '' : '?floorId=' + encodeURIComponent(id);
  return { url: '/api/v2/office/layout' + query, topic: 'layout' + query, query };
}

export function createOfficeLayoutClient(http, id = null) {
  const { url, query } = layoutLocation(id);
  const read = path => http.get(path, { quiet: true }).then(response => response.data);
  const write = (path, body) => http.put(path, body, { quiet: true }).then(response => response.data);
  return {
    get: () => read(url),
    getRevision: revision => read('/api/v2/office/layout/revisions/' + encodeURIComponent(revision) + query),
    put: body => write(url, body),
    putTheme: body => write('/api/v2/office/layout/theme' + query, body),
    forFloor: floor => createOfficeLayoutClient(http, floor),
  };
}

/** Subscribe only after the route answers; dispose guards late HTTP results and stream callbacks. */
export function watchLayout({ client, stream, floorId = null, onChange }) {
  const { topic, url } = layoutLocation(floorId);
  let active = true, unsubscribe;
  const publish = value => { if (active) onChange(value); };
  Promise.resolve().then(() => client.get()).then(data => {
    if (!active) return;
    publish({ data, loading: false, error: null });
    if (active) unsubscribe = stream.subscribe(topic, url, publish);
  }).catch(error => publish({ data: undefined, loading: false, error }));
  return () => { active = false; unsubscribe?.(); };
}
