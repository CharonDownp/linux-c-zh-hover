'use strict';
// The compact view is derived from the existing six-field entry. Never rewrite
// the saved source record: older offline libraries and cache files remain intact.
function firstThought(raw, limit=64) {
  const text=String(raw ?? '').replace(/\s+/g,' ').trim();
  if (!text) return '详见完整说明';
  // Prefer natural Chinese sentence boundaries; omit verbose examples/side notes.
  const separators=['；','。','。 ','; ','。','。','\n'];
  let head=text;
  for(const sep of separators){const index=head.indexOf(sep);if(index>0)head=head.slice(0,index);}
  // Within descriptive parameter definitions, a comma often introduces details.
  if (head.length>limit) {
    const comma=head.search(/[，,]/);
    if (comma>=12 && comma<limit) head=head.slice(0,comma);
  }
  return head.length>limit ? head.slice(0,limit-1).replace(/[，,、：: ]+$/,'')+'…' : head;
}
function conciseParams(params,max=4) {
  const limited=params.slice(0,max).map(p=>{
    const s=String(p);
    const colon=s.search(/[：:]/);
    if(colon<0)return firstThought(s,55);
    const key=s.slice(0,colon+1).trim();
    return key+firstThought(s.slice(colon+1),Math.max(12,58-key.length));
  });
  if (params.length>max) limited.push(`其余 ${params.length-max} 个参数详见完整说明`);
  return limited;
}
function briefOf(entry) {
  return {
    summary:firstThought(entry[1],65),
    params:conciseParams(entry[2]),
    success:firstThought(entry[3],78),
    failure:firstThought(entry[4],78)
  };
}
module.exports={firstThought,conciseParams,briefOf};
