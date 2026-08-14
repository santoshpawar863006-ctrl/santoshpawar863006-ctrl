'use strict';

// Enrich the existing View Details modal using fields already stored in tenders.json.
// This avoids requiring a logged-in KPPP session for information the collector already has.
function renderListingFallback(t, loading=false, message=''){
  const r=t.raw||{};
  const value=first(r,['ecv','estimatedContractValue','estimatedAmount','tenderValue'],t.amount);
  const emd=first(r,['emd','emdAmount','emdValue'],t.emd);
  const fee=first(r,['tenderFee','tenderFeeAmount','fee'],t.fee);
  const tenderNo=first(r,['tenderNumber','tenderNo','tenderReferenceNumber'],t.ref_no||t.id);
  const department=first(r,['deptName','departmentName','department'],t.department);
  const location=first(r,['locationName','location','placeOfWork'],t.location||t.derived_city);
  const description=first(r,['description','tenderDescription','workDescription','title'],t.title);
  const published=first(r,['publishedDateStr','publishedDate','publishDate'],t.published_date);
  const closing=first(r,['tenderClosureDateStr','tenderClosureDate','closingDate','bidSubmissionEndDate'],t.closing_date);
  const evaluation=first(r,['evaluationTypeText','evaluationType']);
  const commercial=first(r,['textCommercialBidType','commercialBidType','bidValueTypeText','bidValueType']);
  const tenderType=first(r,['tenderType','invitingStrategyText','invitingStrategy']);
  const workCategory=first(r,['workCategoryName','categoryText']);
  const calls=first(r,['noOfCalls','noOfCall']);
  const post=first(r,['postName','tenderPublishedUserPost']);
  const nitId=first(r,['nitId','nitID']);
  const estimateId=first(r,['estimateId']);
  const locationId=first(r,['locationId']);
  const deptId=first(r,['deptId']);
  const status=first(r,['statusText','status'],t.status_text||t.status);

  const banner = loading
    ? '<div class="live-banner loading"><span class="spinner"></span> Loading additional KPPP detail…</div>'
    : (message ? `<div class="live-banner warning">ℹ ${esc(message)} Showing all details already available in the KPPP tender feed.</div>` : '');

  return `${banner}
    <section class="detail-section detail-overview">
      <div class="section-title"><h3>Overview</h3><span class="source-chip live">KPPP data</span></div>
      <div class="metric-grid">
        ${metric('Estimated Contract Value',money(value,'Refer tender'))}
        ${metric('EMD',money(emd,'Refer tender'))}
        ${metric('Tender Fee',money(fee,'Refer tender'))}
        ${metric('Closing',text(closing,'Not available'))}
      </div>
      <div class="info-grid">
        ${info('Tender Number',tenderNo)}
        ${info('Category',first(r,['category'],t.category))}
        ${info('Department',department)}
        ${info('City / District',t.derived_city)}
        ${info('Work Location',location)}
        ${info('Work Category',workCategory)}
        ${info('Tender Type',tenderType)}
        ${info('Evaluation System',evaluation)}
        ${info('Commercial Bid Type',commercial)}
        ${info('No. of Calls',calls)}
        ${info('Status',status)}
        ${info('Publishing Office / Post',post)}
      </div>
      ${description?`<div class="description-box"><strong>Work Description</strong><p>${esc(description)}</p></div>`:''}
    </section>

    <section class="detail-section">
      <div class="section-title"><h3>Important Dates</h3></div>
      <div class="info-grid">
        ${info('Published',published)}
        ${info('Tender Closing',closing)}
        ${info('Query / Clarification Closing',first(r,['tenderQueryClose','tenderQueryCloseDate','queryCloseDate']))}
        ${info('Technical Bid Opening',first(r,['technicalBidOpen','technicalBidOpenDate']))}
      </div>
    </section>

    <section class="detail-section">
      <div class="section-title"><h3>KPPP Reference Details</h3></div>
      <div class="info-grid">
        ${info('Tender ID',t.id)}
        ${info('NIT ID',nitId)}
        ${info('Estimate ID',estimateId)}
        ${info('Department ID',deptId)}
        ${info('Location ID',locationId)}
        ${info('Office Code',post)}
      </div>
    </section>

    ${renderAvailableRaw(r)}`;
}

function renderAvailableRaw(raw){
  if(!raw || typeof raw!=='object') return '';
  const skip=new Set(['id','tenderNumber','title','description','category','deptName','departmentName','locationName','ecv','emd','emdAmount','tenderFee','publishedDate','publishedDateStr','tenderClosureDate','tenderClosureDateStr','status','statusText','evaluationType','evaluationTypeText','commercialBidType','textCommercialBidType','tenderType','invitingStrategy','invitingStrategyText','noOfCalls','postName','nitId','estimateId','locationId','deptId','workCategoryName']);
  const entries=Object.entries(raw).filter(([k,v])=>!skip.has(k)&&v!==null&&v!==''&&typeof v!=='object'&&typeof v!=='boolean').slice(0,24);
  if(!entries.length) return '';
  return `<section class="detail-section subdued"><div class="section-title"><h3>Additional KPPP Fields</h3></div><div class="raw-list">${entries.map(([k,v])=>`<div><span>${esc(k.replace(/([A-Z])/g,' $1').trim())}</span><strong>${esc(v)}</strong></div>`).join('')}</div></section>`;
}
