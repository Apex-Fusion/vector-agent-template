export function renderResellerDashboardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reseller capacity</title>
<style>
:root{color-scheme:dark;--bg:#071014;--panel:#0d1a20;--line:#24363d;--text:#eef5f5;--muted:#98aeb5;--good:#50d890;--warn:#ffcb66;--bad:#ff7b72;--accent:#75bfff}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,#12303a 0,transparent 34rem),var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{width:min(1180px,calc(100% - 32px));margin:0 auto;padding:42px 0 64px}header{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:24px}h1{font-size:clamp(28px,5vw,48px);line-height:1.05;margin:0;letter-spacing:-.04em}header p{margin:8px 0 0;color:var(--muted)}.stamp{color:var(--muted);font-variant-numeric:tabular-nums}.panel{background:color-mix(in srgb,var(--panel) 94%,transparent);border:1px solid var(--line);border-radius:16px;box-shadow:0 16px 48px #0005}.identity{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:1px;overflow:hidden;margin-bottom:16px}.identity>div{padding:18px 20px;background:var(--panel)}.label{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.12em;margin-bottom:6px}.value{font-size:17px;font-weight:650;overflow-wrap:anywhere}.status{display:inline-flex;align-items:center;gap:8px}.dot{width:9px;height:9px;border-radius:50%;background:var(--muted);box-shadow:0 0 0 4px #fff1}.status.free .dot{background:var(--good)}.status.working .dot{background:var(--warn)}.status.offline .dot{background:var(--bad)}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:0 0 24px}.metric{padding:18px}.metric strong{display:block;font-size:24px;letter-spacing:-.03em;font-variant-numeric:tabular-nums}.metric small{color:var(--muted)}.section-head{display:flex;justify-content:space-between;align-items:center;margin:28px 0 12px}h2{font-size:18px;margin:0}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:940px}th,td{text-align:left;padding:13px 14px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.09em;font-weight:600}tbody tr:last-child td{border-bottom:0}.job-status{font-weight:700}.job-status.settled{color:var(--good)}.job-status.failed{color:var(--bad)}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.preview{max-width:250px;color:#c9d8dc;white-space:normal}.empty,.error{padding:30px;color:var(--muted)}.error{color:var(--bad)}
a.explorer-link{color:var(--accent);text-decoration:none;text-underline-offset:3px}a.explorer-link:hover,a.explorer-link:focus-visible{text-decoration:underline}
@media(max-width:820px){header{align-items:flex-start;flex-direction:column}.identity{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,1fr)}}@media(max-width:480px){main{width:min(100% - 20px,1180px);padding-top:24px}.metrics{grid-template-columns:1fr}.metric strong{font-size:21px}}
</style>
</head>
<body>
<main>
<header><div><h1>Provider capacity resale</h1><p>Bounded upstream capacity settled through Vector escrow.</p></div><div class="stamp" id="updated">Loading current state</div></header>
<section class="panel identity" aria-label="Agent identity">
<div><span class="label">Route</span><span class="value" id="route">Loading</span></div>
<div><span class="label">Marketplace model</span><span class="value" id="market-model">Loading</span></div>
<div><span class="label">Supplier status</span><span class="status" id="status"><span class="dot"></span><span id="status-text">Loading</span></span><div class="stamp" id="reason"></div></div>
</section>
<section class="metrics" aria-label="Capacity and settlement metrics">
<div class="panel metric"><span class="label">Sellable allowance</span><strong id="sellable">--</strong><small id="allowance">Provider allowance --</small></div>
<div class="panel metric"><span class="label">Worst-case job</span><strong id="worst-job">--</strong><small id="available-jobs">-- jobs available</small></div>
<div class="panel metric"><span class="label">AP3X earned</span><strong id="earned">--</strong><small id="settled-count">-- settled jobs</small></div>
<div class="panel metric"><span class="label">Upstream spend</span><strong id="spend">--</strong><small id="failed-count">-- failed jobs</small></div>
</section>
<div class="section-head"><h2>Conversion timeline</h2><span class="stamp">Public previews require buyer consent</span></div>
<section class="panel table-wrap"><table><thead><tr><th>Time</th><th>Status</th><th>Model</th><th>Prompt preview</th><th>Output preview</th><th>Upstream</th><th>Payout</th><th>Escrow</th></tr></thead><tbody id="jobs"><tr><td colspan="8" class="empty">Loading jobs</td></tr></tbody></table></section>
</main>
<script>
(function(){
  'use strict';
  var byId=function(id){return document.getElementById(id)};
  var text=function(id,value){byId(id).textContent=value==null?'--':String(value)};
  var money=function(value){return '$'+String(value==null?'0':value)};
  function renderStatus(state){
    text('route',state.provider+' / '+state.provider_model);
    text('market-model',state.marketplace_model);
    var status=byId('status');status.className='status '+state.status;
    text('status-text',state.status);text('reason',state.reason);
    text('sellable',money(state.capacity.sellable_usd));
    text('allowance','Allowance '+money(state.capacity.remaining_allowance_usd)+' · reserve '+money(state.capacity.protected_reserve_usd)+' · committed '+money(state.capacity.committed_usd));
    text('worst-job',money(state.capacity.worst_case_job_usd));
    text('available-jobs',state.capacity.available_jobs==null?'No balance limit':state.capacity.available_jobs+' jobs available');
    text('earned',state.totals.ap3x_earned+' AP3X');
    text('settled-count',state.totals.settled_jobs+' settled jobs');
    text('spend',money(state.totals.upstream_spend_usd));
    text('failed-count',state.totals.failed_jobs+' failed jobs');
    text('updated','Updated '+new Date().toLocaleTimeString());
  }
  function cell(row,value,className){var td=document.createElement('td');if(className)td.className=className;td.textContent=value==null?'--':String(value);row.appendChild(td)}
  function escrowCell(row,value){
    var td=document.createElement('td');td.className='mono';
    var ref=typeof value==='string'?value:'';
    var txHash=ref.split('#')[0];
    if(/^[0-9a-fA-F]{64}$/.test(txHash)){
      var link=document.createElement('a');
      link.className='explorer-link';
      link.href='https://vector.apexscan.org/en/transaction/'+txHash+'/summary/';
      link.target='_blank';link.rel='noopener noreferrer';
      link.textContent=ref;
      link.setAttribute('aria-label','View escrow transaction '+txHash+' on ApexScan');
      td.appendChild(link);
    }else{
      td.textContent=ref||'--';
    }
    row.appendChild(td);
  }
  function renderJobs(rows){
    var body=byId('jobs');body.replaceChildren();
    if(!rows.length){var row=document.createElement('tr');cell(row,'No terminal jobs yet','empty');row.firstChild.colSpan=8;body.appendChild(row);return}
    rows.forEach(function(job){
      var row=document.createElement('tr');
      cell(row,new Date(job.created_at).toLocaleString());
      cell(row,job.status,'job-status '+job.status);
      cell(row,job.marketplace_model,'mono');
      cell(row,job.prompt_preview,'preview');
      cell(row,job.output_preview,'preview');
      cell(row,job.upstream_cost_usd==null?'--':money(job.upstream_cost_usd));
      cell(row,job.ap3x_payout+' AP3X');
      escrowCell(row,job.escrow_ref);
      body.appendChild(row);
    });
  }
  function showError(message){var body=byId('jobs');body.replaceChildren();var row=document.createElement('tr');cell(row,message,'error');row.firstChild.colSpan=8;body.appendChild(row);text('updated','Data unavailable')}
  async function refresh(){
    try{
      var results=await Promise.all([fetch('/reseller/api/status',{cache:'no-store'}),fetch('/reseller/api/jobs?limit=50',{cache:'no-store'})]);
      if(!results[0].ok||!results[1].ok)throw new Error('Seller evidence is unavailable');
      var data=await Promise.all([results[0].json(),results[1].json()]);renderStatus(data[0]);renderJobs(data[1].jobs||[]);
    }catch(error){showError(error instanceof Error?error.message:'Seller evidence is unavailable')}
  }
  refresh();setInterval(refresh,5000);
})();
</script>
</body>
</html>`;
}
