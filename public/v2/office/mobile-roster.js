// Mobile-only roster. Canonical parentId defines stacks; delegation cues support older servers.
import { html } from '../lib.js';
import * as i18n from '../i18n.js';
import { Button } from '../components/bureau/forms.js';
import { Icon } from '../components/ui.js';
import { s as tr } from './strings.js';
export { Button };

export function MobileRoster({all=false,occupants,rosterItems=[],rosterPreviewItems=[],rosterOverflowCount=0,rosterOverflowLabel,conversationIds=[],conversationCount=0,conversationLabel,selected,onSelect,onAll,onTeam,onConversations,manifest,unconfirmed,Avatar,StateChip,nameOf,roleLabel,label,stateTitle,emptyLabel,allLabel}) {
  const byId=new Map(occupants.map(o=>[o.id,o]));
  const visibleItems=all?rosterItems:rosterPreviewItems;
  const visible=visibleItems.map(item=>({item,parent:byId.get(item.rootId),preview:(item.previewOccupantIds||[]).map(id=>byId.get(id)).filter(Boolean)})).filter(group=>group.parent);
  if(!occupants.length)return html`<p class="ao-mobile-roster bu-text-secondary">${emptyLabel}</p>`;
  return html`<section class="ao-mobile-roster" aria-label=${tr('office.rosterLabel')}>
    ${visible.map(({item,parent:o,preview},index)=>{
      const chip=html`<${StateChip} state=${o.state} stateLabel=${o.stateLabel} stateActive=${o.stateActive} live=${!unconfirmed&&!o.presence&&!o.sourceStale} title=${stateTitle(o)} />`;
      if(item.isGroup)return html`<div class="bu-roster ao-mobile-group" key=${o.id}>
        <${Button} class="ao-mobile-stack" iconOnly variant="ghost" label=${label(item.openLabel)}
          icon=${html`<span class="ao-mobile-stack__avatars">${preview.map(person=>html`<${Avatar} o=${person} manifest=${manifest} />`)}${item.overflowCount>0?html`<span class="ao-mobile-stack__count">${label(item.overflowLabel)}</span>`:null}</span>`}
        onPress=${()=>onTeam({name:nameOf(o),ids:item.occupantIds})} />
        <button type="button" class="ao-mobile-parent" data-mobile-agent=${o.id} aria-current=${selected===o.id?'true':undefined} onClick=${()=>onSelect(o.id,{name:nameOf(o),ids:item.occupantIds})}>
          <span class="ao-agentcard__name" title=${nameOf(o)}>${nameOf(o)}</span><span class="bu-cell-sub">${o.runtime || roleLabel(o.roleLabel)}</span><span class="bu-cell-sub">${label(item.delegatesLabel)}</span>
        </button>${chip}</div>`;
      return html`<button type="button" key=${o.id} class=${'bu-roster ao-agentcard'+(index?' ao-mobile-peer':'')} data-mobile-agent=${o.id} data-source-stale=${o.sourceStale||undefined} aria-current=${selected===o.id?'true':undefined} onClick=${()=>onSelect(o.id)}>
        <${Avatar} o=${o} manifest=${manifest} /><span class="bu-cell-main"><span class="ao-agentcard__name" title=${nameOf(o)}>${nameOf(o)}</span><span class="bu-cell-sub">${o.runtime||roleLabel(o.roleLabel)}</span></span>${chip}</button>`;
    })}
    ${!all&&rosterOverflowCount>0?html`<button type="button" class="bu-btn bu-btn--ghost ao-mobile-more" data-overflow-count=${rosterOverflowCount} aria-label=${label(allLabel)} onClick=${onAll}>${label(rosterOverflowLabel)}</button>`:null}
    ${conversationCount>0&&onConversations?html`<${Button} variant="ghost" icon=${html`<${Icon} name="discuter" />`} label=${label(conversationLabel)} onPress=${()=>onConversations(conversationIds)} />`:null}
  </section>`;
}
