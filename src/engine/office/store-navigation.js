'use strict';

// Canonical installed catalogue → Store controls. No provider/session data.
const { floorId: validFloorId } = require('./floors');
const SECTIONS = ['mobilier', 'decoration', 'personnages', 'couleurs', 'accessoires', 'themes'];
const FURNITURE_CATEGORIES = new Set(['poste', 'assise', 'rangement', 'equipement']);
const CATEGORIES = new Set(['poste','assise','rangement','equipement','plante','deco','sol','mur']);
const SLOTS = new Set(['head','face','neck','badge','back','hand','wrist']);
const ref = key => ({ key });
const sectionOf = item => FURNITURE_CATEGORIES.has(item.category) ? 'mobilier' : 'decoration';
function queryError(field) { const error = Error('invalid Store selection'); error.field = field; throw error; }
function floorLabel(id) {
  return id === 'rdc' ? ref('office.floor.rdc') : id === 'gym' ? ref('office.floor.gym')
    : id === '1' ? ref('office.floor.first') : { key:'office.floor.number',params:{n:Number(id)} };
}

function buildStoreNavigation({ index, floors, floorId = '1', section = 'mobilier', category = '' }) {
  if (!validFloorId(floorId)) queryError('floorId');
  if (!SECTIONS.includes(section)) queryError('section');
  if (typeof category !== 'string' || category.length > 64) queryError('category');
  const furniture = [...index.furniture.values()], characters = [...index.characters.values()];
  const accessories = [...index.accessories.values()];
  const counts = { mobilier:0, decoration:0, personnages:characters.length,
    couleurs:characters.reduce((n,c) => n + (c.variants?.length || 0),0), accessoires:accessories.length,
    themes:3 + [...index.themes.values()].filter(item => item.kind === 'season').length };
  for (const item of furniture) counts[sectionOf(item)]++;
  const floorSection = section === 'mobilier' || section === 'decoration';
  const catalogue = floorSection ? furniture.filter(item => sectionOf(item) === section)
    : section === 'accessoires' ? accessories : null;
  const categoryOf = item => floorSection ? item.category : item.slot;
  let categories = null;
  if (catalogue) {
    const groups = new Map();
    for (const item of catalogue) {
      const id = categoryOf(item); if (!id) continue;
      groups.set(id,(groups.get(id) || 0) + 1);
    }
    if (category && !groups.has(category)) queryError('category');
    categories = { label:ref('office.store.category'),options:[{id:'',label:ref('office.store.all'),count:catalogue.length},
      ...[...groups].map(([id,count]) => ({id,count,label:(floorSection ? CATEGORIES : SLOTS).has(id)
        ? ref(`office.store.${floorSection ? 'category' : 'slot'}.${id}`)
        : {key:'office.store.other',params:{name:id}}}))] };
  } else if (category) queryError('category');
  const choices = new Map((floors || []).map(floor => [floor.id,{id:floor.id,label:floor.label || floorLabel(floor.id),count:null}]));
  if (!choices.has(floorId)) choices.set(floorId,{id:floorId,label:floorLabel(floorId),count:null});
  return {floorId,sectionId:section,categoryId:categories ? category : null,
    sections:{label:ref('office.store.section'),options:SECTIONS.map(id => ({id,label:ref('office.store.section.'+id),count:counts[id]}))},
    categories,floors:floorSection ? {label:ref('office.store.floor'),options:[...choices.values()]} : null,
    itemIds:catalogue ? catalogue.filter(item => !category || categoryOf(item) === category).map(item => item.id) : []};
}
module.exports = {buildStoreNavigation};
