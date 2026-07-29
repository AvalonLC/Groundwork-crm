import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const source = readFileSync(new URL('../public/js/app_premium.js', import.meta.url), 'utf8');

function sourceBlock(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `missing source block ${startMarker}`);
  return source.slice(start, end);
}

function harness(html = '<main><div id="spb-action-result"></div></main>') {
  const { window, document } = parseHTML(html);
  const alerts = [];
  const confirms = [];
  const context = {
    window,
    document,
    view: document.querySelector('main'),
    DB: { salesProcess: {} },
    escapeHtml(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
    money(value) { return `$${Number(value || 0).toFixed(2)}`; },
    alert(message) { alerts.push(String(message)); },
    confirm(message) { confirms.push(String(message)); return true; },
    console,
    setTimeout,
    clearTimeout
  };
  window.innerWidth = 390;
  window.scrollTo = () => {};
  return { window, document, context, alerts, confirms };
}

function selectValue(select, value) {
  for (const option of select.querySelectorAll('option')) option.toggleAttribute('selected', option.getAttribute('value') === value || (!option.hasAttribute('value') && option.textContent === value));
  Object.defineProperty(select, 'value', { value, writable:true, configurable:true });
}

test('Needs Restaging mobile workspace filters saves and never defaults unknown labels', async () => {
  const h = harness();
  const mappings = [
    { opportunity_id:'unknown', client:'Unknown Customer', previous_label:'Mystery', suggestion_reason:'Unknown legacy label', mapping_confidence:.2, assigned_to_rep_id:'rep-a', last_activity:'2026-01-01', next_follow_up:'', estimate_status:'sent', estimate_sent_date:'2026-01-02', appointment_count:1, job_value:500, notes_preview:'Review this record', review_state:'pending' },
    { opportunity_id:'clear', client:'Clear Customer', previous_label:'Lead Intake / Rapport', suggestion_reason:'Exact legacy mapping', mapping_confidence:.98, assigned_to_rep_id:'rep-b', proposed_stage_id:'stage-intake', appointment_count:0, job_value:250, review_state:'pending' }
  ];
  const approved = [];
  h.context.DB.salesProcess = {
    mappings: async () => mappings,
    inventory: async () => ({ reconciliation:{ opportunity_count:2, mapping_count:2, value:750 } }),
    get: async () => ({ stages:[{ id:'stage-intake', display_name:'Welcome' },{ id:'stage-review', display_name:'Review' }] }),
    approveMapping: async (...args) => { approved.push(args); },
    captureSnapshot: async () => ({ snapshot_id:'snapshot-1' }),
    approveSnapshot: async () => ({ state:'approved' }),
    preview: async () => ({ impact:{ opportunities_affected:2, value_affected:750, mappings:{ automatic:1, manual:1, unknown:0 } }, surfaces:['pipeline','mobile'] })
  };
  vm.runInNewContext(sourceBlock('window.gwRenderRestagingWorkspace=', '\nfunction renderStage'), h.context);
  for (const name of ['gwRenderRestagingWorkspace','gwFilterRestaging','gwSaveRestaging','gwBulkApproveRestaging','gwApproveRestagingSnapshot']) h.context[name] = h.window[name];
  await h.window.gwRenderRestagingWorkspace('batch-1', 'version-1');

  const rows = [...h.document.querySelectorAll('.spb-restaging-row')];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /Original stage: Mystery/);
  assert.match(rows[0].textContent, /Unknown Customer/);
  assert.match(rows[0].textContent, /Representative: rep-a/);
  assert.match(rows[0].textContent, /Review this record/);
  assert.equal(rows[0].querySelector('.restage-stage').value, '');
  assert.match(rows[0].querySelector('.restage-stage').textContent, /Needs review - select a stage/);

  selectValue(h.document.getElementById('restage-rep'), 'rep-a');
  h.window.gwFilterRestaging();
  assert.equal(rows[0].style.display, 'grid');
  assert.equal(rows[1].style.display, 'none');

  await h.window.gwSaveRestaging(0);
  assert.equal(approved.length, 0);
  assert.match(h.alerts.at(-1), /Select a reviewed stage/);
  selectValue(rows[0].querySelector('.restage-stage'), 'stage-review');
  await h.window.gwSaveRestaging(0);
  assert.equal(approved[0][1], 'unknown');
  assert.equal(approved[0][2], 'stage-review');
  assert.equal(mappings[0].review_state, 'approved');

  selectValue(h.document.getElementById('restage-rep'), '');
  await h.window.gwBulkApproveRestaging();
  assert.ok(approved.some(call => call[1] === 'clear' && call[2] === 'stage-intake'));
});

test('preview publication and rollback controls enforce gates roles confirmation and refresh', async () => {
  const h = harness();
  let ready = false;
  let published = 0;
  let rolledBack = 0;
  let builderVersion = '';
  h.window._gwBuilder = { payload:{ process:{ id:'version-1' } }, revision:4 };
  h.window._gwRestaging = { batchId:'batch-1' };
  h.window.getCurrentRep = () => ({ id:'admin-a', role:'admin' });
  h.window.showToast = () => {};
  h.context.salesProcessBuilder = async version => { builderVersion = version; };
  h.context.DB.salesProcess = {
    preview: async () => ({ stages:[{ display_name:'Welcome', semantic_type:'intake' },{ display_name:'Review', semantic_type:'proposal_presentation' }], sample_transitions:[{ from_stage_name:'Welcome', to_stage_name:'Review', requires_override:0 }], impact:{ opportunities_affected:3, value_affected:900, mappings:{ automatic:1, manual:1, unknown:1 }, reporting_changes:2, automation_changes:[{}], training_changes:[{}] }, surfaces:['pipeline','opportunity_detail','stage_guide','call_companion','representative_view','reporting','mobile'] }),
    readiness: async () => ready ? { ready:true, issues:[] } : { ready:false, issues:[{ code:'mapping_not_approved', opportunity_id:'opp-1' }] },
    publish: async () => { published++; return { published:'version-1' }; },
    rollback: async () => { rolledBack++; return { rolled_back_to:'version-0' }; }
  };
  vm.runInNewContext(sourceBlock('window.gwRollbackPublication=', '\nwindow.gwAdoptGroundworkTemplate='), h.context);

  await h.window.gwPreviewSalesProcess();
  assert.match(h.document.getElementById('spb-action-result').textContent, /Gates incomplete/);
  assert.match(h.document.getElementById('spb-action-result').textContent, /mapping_not_approved/);
  assert.equal(h.document.querySelector('[onclick^="gwPublishSalesProcess"]'), null);

  ready = true;
  await h.window.gwPreviewSalesProcess();
  const previewText = h.document.getElementById('spb-action-result').textContent;
  for (const text of ['Ready to publish','Opportunities affected','Value affected','Automatic mappings','Manual mappings','Unknown mappings','Sample transitions','mobile']) assert.match(previewText, new RegExp(text));
  assert.ok(h.document.querySelector('[onclick^="gwPublishSalesProcess"]'));

  h.window.getCurrentRep = () => ({ id:'rep-a', role:'representative' });
  await h.window.gwPublishSalesProcess('batch-1');
  assert.equal(published, 0);
  assert.match(h.alerts.at(-1), /Administrator approval/);
  h.window.getCurrentRep = () => ({ id:'manager-a', role:'sales_manager' });
  await h.window.gwPublishSalesProcess('batch-1');
  assert.equal(published, 1);
  assert.equal(builderVersion, 'version-1');
  assert.match(h.confirms[0], /Publish this approved immutable sales process/);

  await h.window.gwRollbackPublication('publication-1', 'version-0');
  assert.equal(rolledBack, 1);
  assert.equal(builderVersion, 'version-0');
  assert.match(h.confirms[1], /Later notes, activities, estimates, appointments, and communications will be preserved/);
});

test('Builder stage controls remain operable in a mobile DOM', () => {
  const h = harness('<main><div id="spb-stage-list"><div class="spb-stage-row" data-id="stage-a"><input name="display_name" value="First"><select name="semantic_type"><option value="active_qualification" selected>active_qualification</option></select><textarea>Guidance</textarea></div><div class="spb-stage-row" data-id="stage-b"><input name="display_name" value="Second"><select name="semantic_type"><option value="active_qualification" selected>active_qualification</option></select><textarea>Guidance</textarea></div></div></main>');
  vm.runInNewContext(sourceBlock('window.gwMoveBuilderStage=', '\nwindow.gwSaveBuilderStages='), h.context);
  const first = h.document.querySelector('.spb-stage-row');
  h.window.gwDuplicateBuilderStage({ closest:() => first });
  assert.equal(h.document.querySelectorAll('.spb-stage-row').length, 3);
  assert.equal(h.document.querySelectorAll('.spb-stage-row')[1].querySelector('[name=display_name]').value, 'First Copy');
  h.window.gwAddBuilderStage();
  assert.equal(h.document.querySelectorAll('.spb-stage-row').length, 4);
  assert.equal(h.document.querySelectorAll('.spb-stage-row')[3].querySelector('[name=display_name]').value, 'New stage');
  const last = h.document.querySelectorAll('.spb-stage-row')[3];
  h.window.gwMoveBuilderStage({ closest:() => last }, -1);
  assert.equal(h.document.querySelectorAll('.spb-stage-row')[2].querySelector('[name=display_name]').value, 'New stage');
});
