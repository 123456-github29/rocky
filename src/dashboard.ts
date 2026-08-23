/**
 * The dashboard page, as a string. One file, no build step, no external
 * requests — which is what keeps rocky's dependency list at one entry and lets
 * `rocky serve` work on a box with no network.
 *
 * Ticket text is written by whoever filed the bug: an error tracker, a
 * customer's email, a Slack message. It reaches the page as data and is only
 * ever set with textContent — never innerHTML, never a template literal into
 * markup.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>rocky</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbfa; --panel: #fff; --ink: #1a1a19; --dim: #6b6b68;
    --line: #e4e4e1; --accent: #2f6f4f; --danger: #8c3b3b; --chip: #f0efec;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16171a; --panel: #1e2024; --ink: #e8e8e6; --dim: #9a9a96;
      --line: #2e3138; --accent: #6fbf8f; --danger: #d98b8b; --chip: #262a30;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
    padding: 20px 24px; border-bottom: 1px solid var(--line);
  }
  h1 { font-size: 17px; margin: 0; letter-spacing: -0.01em; }
  .gate { color: var(--dim); font-size: 13px; }
  .gate code { background: var(--chip); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  #status { margin-left: auto; color: var(--dim); font-size: 13px; }
  main { padding: 24px; max-width: 900px; margin: 0 auto; }
  section { margin-bottom: 32px; }
  h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.07em;
    color: var(--dim); margin: 0 0 12px; font-weight: 600;
  }
  .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 16px 18px; margin-bottom: 10px;
  }
  .card h3 { font-size: 15px; margin: 0 0 6px; font-weight: 600; }
  .id { color: var(--dim); font-weight: 400; }
  .summary {
    color: var(--dim); font-size: 13px; margin: 0 0 12px; white-space: pre-wrap;
    max-height: 7.5em; overflow: hidden;
  }
  .summary.raw { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .brief { margin: 0 0 12px; }
  .brief p { margin: 0 0 8px; font-size: 14px; }
  .brief dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; font-size: 13px; }
  .brief dt { color: var(--dim); }
  .brief dd { margin: 0; }
  .brief .risk { color: var(--danger); }
  .hedge { font-size: 12px; color: var(--dim); margin: 8px 0 0; font-style: italic; }
  details.raw-report { margin: 0 0 12px; }
  details.raw-report summary {
    cursor: pointer; font-size: 12px; color: var(--dim); list-style: revert;
  }
  details.raw-report pre {
    margin: 8px 0 0; padding: 10px 12px; background: var(--chip); border-radius: 7px;
    font-size: 12px; white-space: pre-wrap; overflow-x: auto; max-height: 16em;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  a { color: var(--accent); }
  button {
    font: inherit; font-size: 13px; padding: 6px 14px; border-radius: 7px;
    border: 1px solid var(--line); background: var(--panel); color: var(--ink); cursor: pointer;
  }
  button:hover:not(:disabled) { border-color: var(--dim); }
  button.approve { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 500; }
  button.deny { color: var(--danger); }
  button:disabled { opacity: 0.45; cursor: default; }
  .meta { margin-left: auto; font-size: 12px; color: var(--dim); }
  .empty { color: var(--dim); font-size: 14px; padding: 4px 0; }
  .banner {
    background: var(--chip); border: 1px solid var(--line); border-left: 3px solid var(--danger);
    border-radius: 8px; padding: 12px 16px; margin-bottom: 24px; font-size: 14px;
  }
  .done .card { opacity: 0.72; }
  .done .card h3 { font-weight: 400; }
</style>
</head>
<body>
<header>
  <h1>rocky</h1>
  <span class="gate" id="gate"></span>
  <span id="status">loading…</span>
</header>
<main>
  <div class="banner" id="banner" hidden></div>
  <section id="awaiting-section">
    <h2>Waiting on you</h2>
    <div id="awaiting"></div>
  </section>
  <section id="approved-section">
    <h2>Approved — agent working</h2>
    <div id="approved"></div>
  </section>
  <section id="done-section" class="done">
    <h2>Finished</h2>
    <div id="done"></div>
  </section>
</main>
<script>
(function () {
  var token = new URLSearchParams(location.search).get('token');
  var busy = {};

  function api(path, options) {
    var url = token ? path + (path.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token) : path;
    return fetch(url, options).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + r.status);
        return body;
      });
    });
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    // Ticket text comes from error trackers and other people's emails.
    // textContent, always.
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function decide(id, action) {
    if (action === 'deny' && !confirm('Drop ' + id + " from rocky's queue? The ticket stays open.")) return;
    busy[id] = true;
    render(last);
    api('/api/tickets/' + encodeURIComponent(id) + '/' + action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ by: 'dashboard' })
    }).then(refresh).catch(function (error) {
      alert('Could not ' + action + ' ' + id + ': ' + error.message);
    }).then(function () {
      delete busy[id];
      refresh();
    });
  }

  // Rocky writes the brief as markdown at the head of the ticket body, above
  // an "## Original report" heading. Split them so the decision (the brief)
  // reads as prose and the evidence (the report) stays available but folded.
  function splitBody(body) {
    var marker = body.indexOf('## Original report');
    if (body.indexOf('## What needs to be done') !== 0 || marker === -1) {
      return { brief: null, report: body.split('\\n---\\nFiled by rocky.')[0].trim() };
    }
    return {
      brief: body.slice(0, marker).replace(/\\n---\\n\\s*$/, '').trim(),
      report: body.slice(marker + '## Original report'.length).split('\\n---\\nFiled by rocky.')[0].trim()
    };
  }

  // The brief is a fixed shape rocky generated, so this reads its lines rather
  // than rendering arbitrary markdown. Everything still goes in via textContent.
  function renderBrief(text) {
    var host = el('div', 'brief');
    var fields = el('dl');
    var hedge = null;
    var lead = [];

    text.split('\\n').forEach(function (line) {
      var trimmed = line.trim();
      if (trimmed === '' || trimmed === '## What needs to be done') return;
      var field = /^\\*\\*(.+?):\\*\\*\\s*(.*)$/.exec(trimmed);
      if (field) {
        if (field[2]) {
          fields.appendChild(el('dt', null, field[1]));
          fields.appendChild(el('dd', null, field[2]));
        } else {
          fields.appendChild(el('dt', null, field[1]));
          fields.appendChild(el('dd', null, ''));
        }
        return;
      }
      if (trimmed.indexOf('- ') === 0) {
        var last = fields.lastElementChild;
        if (last && last.tagName === 'DD') {
          last.appendChild(document.createTextNode((last.textContent ? ' · ' : '') + trimmed.slice(2)));
          last.className = 'risk';
        }
        return;
      }
      if (trimmed.indexOf('>') === 0 || trimmed.indexOf('_') === 0) {
        hedge = trimmed.replace(/^[>_\\s]+|_$/g, '');
        return;
      }
      lead.push(trimmed);
    });

    if (lead.length) host.appendChild(el('p', null, lead.join(' ')));
    if (fields.childNodes.length) host.appendChild(fields);
    if (hedge) host.appendChild(el('p', 'hedge', hedge));
    return host;
  }

  function card(ticket, actionable) {
    var node = el('div', 'card');
    var heading = el('h3');
    heading.appendChild(el('span', 'id', ticket.id + '  '));
    heading.appendChild(document.createTextNode(ticket.title));
    node.appendChild(heading);

    var parsed = splitBody(ticket.summary || '');
    if (parsed.brief) {
      node.appendChild(renderBrief(parsed.brief));
    } else if (parsed.report) {
      node.appendChild(el('p', 'summary raw', parsed.report));
    }
    if (parsed.brief && parsed.report) {
      var details = el('details', 'raw-report');
      details.appendChild(el('summary', null, 'Original report'));
      details.appendChild(el('pre', null, parsed.report));
      node.appendChild(details);
    }

    var row = el('div', 'row');
    if (actionable) {
      var yes = el('button', 'approve', 'Approve');
      var no = el('button', 'deny', 'Deny');
      yes.disabled = no.disabled = !!busy[ticket.id];
      yes.onclick = function () { decide(ticket.id, 'approve'); };
      no.onclick = function () { decide(ticket.id, 'deny'); };
      row.appendChild(yes);
      row.appendChild(no);
    }
    if (ticket.link) {
      var link = el('a', null, 'Open in tracker');
      link.href = ticket.link;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      row.appendChild(link);
    }
    if (ticket.changedAt) {
      row.appendChild(el('span', 'meta', new Date(ticket.changedAt).toLocaleString()));
    }
    node.appendChild(row);
    return node;
  }

  function fill(id, tickets, actionable, emptyText) {
    var host = document.getElementById(id);
    host.textContent = '';
    if (tickets.length === 0) {
      host.appendChild(el('p', 'empty', emptyText));
      return;
    }
    tickets.forEach(function (t) { host.appendChild(card(t, actionable)); });
  }

  var last = { tickets: [], labels: { funnel: 'rocky', approve: 'approved' } };

  function render(board) {
    last = board;
    var gate = document.getElementById('gate');
    gate.textContent = '';
    gate.appendChild(document.createTextNode('label '));
    gate.appendChild(el('code', null, board.labels.funnel));
    gate.appendChild(document.createTextNode(' → '));
    gate.appendChild(el('code', null, board.labels.approve));

    var banner = document.getElementById('banner');
    if (board.error) {
      banner.textContent = 'Could not reach the tracker: ' + board.error;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }

    var by = function (phase) {
      return board.tickets.filter(function (t) { return t.phase === phase; });
    };
    var finished = board.tickets.filter(function (t) {
      return t.phase === 'done' || t.phase === 'dismissed';
    }).sort(function (a, b) { return (b.changedAt || '').localeCompare(a.changedAt || ''); }).slice(0, 20);

    fill('awaiting', by('awaiting'), true, 'Nothing waiting. Rocky files here as bugs come in.');
    fill('approved', by('approved'), false, 'Nothing in flight.');
    fill('done', finished, false, 'Nothing finished yet.');
    document.getElementById('done-section').hidden = finished.length === 0;
  }

  function refresh() {
    return api('/api/board').then(function (board) {
      render(board);
      document.getElementById('status').textContent = 'updated ' + new Date().toLocaleTimeString();
    }).catch(function (error) {
      document.getElementById('status').textContent = 'disconnected — ' + error.message;
    });
  }

  refresh();
  setInterval(refresh, 5000);
})();
</script>
</body>
</html>
`
