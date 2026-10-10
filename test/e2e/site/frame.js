fetch('/frame-data.json').then(r => r.json()).then(d => document.body.append(' ' + d.ok));
