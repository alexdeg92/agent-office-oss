// Synthetic API/demo producer only. The product editor consumes its VM unchanged.
let catalogue;
export async function mockPalette({floorId='1',category='',search=''}={}) {
  catalogue ||= fetch(new URL('./examples/office-palette-catalog.json',import.meta.url)).then(async response=>{
    if(!response.ok)throw Error('palette catalogue unavailable');return response.json();
  }).catch(error=>{catalogue=null;throw error;});
  const {vm:seed,items}=await catalogue,vm=structuredClone(seed);
  vm.floorId=floorId;vm.categoryId=category;vm.search=search;
  if(!vm.categories.options.some(option=>option.id===category)||typeof search!=='string'||search.length>120)throw Error('invalid palette selection');
  const norm=value=>String(value).normalize('NFD').replace(/\p{M}/gu,'').toLowerCase(),needle=norm(search.trim());
  vm.itemIds=items.filter(item=>(!category||item.category===category)&&(!needle||[item.id,item.label,...Object.values(item.names)].some(value=>norm(value).includes(needle)))).map(item=>item.id);
  return vm;
}
