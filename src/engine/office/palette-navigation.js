'use strict';
// Canonical installed furniture (including lazy pack registrations) → editor palette.
const { floorId: validFloorId } = require('./floors');
const ORDER = ['poste','assise','rangement','plante','equipement','mur','sol','deco'];
const normalize = value => String(value).normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
function invalid(field) { const error = Error('invalid palette selection'); error.field = field; throw error; }
function buildPaletteNavigation({index,floorId='1',category='',search=''}) {
  if (!validFloorId(floorId)) invalid('floorId');
  if (typeof category !== 'string' || category.length > 64) invalid('category');
  if (typeof search !== 'string' || search.length > 120) invalid('search');
  const all = [...index.furniture.values()], counts = new Map();
  for (const item of all) if(item.category) counts.set(item.category,(counts.get(item.category)||0)+1);
  if (category && !counts.has(category)) invalid('category');
  const categories = [...ORDER.filter(id=>counts.has(id)),...([...counts.keys()].filter(id=>!ORDER.includes(id)))];
  const needle = normalize(search.trim());
  const itemIds = all.filter(item=>(!category || category===item.category) && (!needle ||
    [item.id,item.label,...Object.values(item.names||{})].some(value=>normalize(value).includes(needle)))).map(item=>item.id);
  return {floorId,categoryId:category,search,categories:{label:{key:'office.store.category'},options:[
    {id:'',label:{key:'office.store.all'},count:all.length},...categories.map(id=>({id,count:counts.get(id),
      label:ORDER.includes(id)?{key:'office.store.category.'+id}:{key:'office.store.other',params:{name:id}}}))]},itemIds};
}
module.exports = {buildPaletteNavigation};
