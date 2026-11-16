/* The feed card renderer, lifted out of index.html.

   renderPost was 326 lines inside index.html and could not be tested at all: every
   change to a card meant opening a browser and looking at it. It is also the part
   of the page most likely to break, because it builds four different card shapes.

   What actually blocked lifting it was STATE, not size. Measured, it touches only
   six things from the page:

     profileCache, eventsCache, myBookmarks, myFollowing, currentUserPubkey,
     initMetrics(), requestMetrics(), injectZapControls(), requestProfileInfo(),
     updateMetricsUI(), and the container it inserts into

   The onclick handlers in the markup (likeEvent, openRawModal, toggleBookmark and
   friends) are NOT in this list on purpose: they are strings, resolved against
   window when a reader clicks, so they keep working without injection.

   (myFollowing was missed on the first pass and only showed up when the function
   was actually executed against a fake DOM, which is the argument for testing it
   rather than reading it.)

   So the function is lifted as-is, with those six injected through a context
   object. Nothing else changed: the 38 onclick handlers in the markup still resolve
   against window at click time, the same modules are used for media, articles,
   pulses and links, and the insertion order logic is untouched.

   ctx = {
     profileCache, eventsCache, myBookmarks, myFollowing,
     pubkey,              the current user, or null
     initMetrics(id), requestMetrics(id),
     container,           the element cards are inserted into
     document             optional, defaults to the global document
   }
*/
(function (global) {
    'use strict';

    function escapeHtml(str) {
        if (global.NostrUtil) return global.NostrUtil.escapeHtml(str);
        return String(str === undefined || str === null ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function timeAgo(ts) {
        if (global.NostrUtil) return global.NostrUtil.timeAgo(ts);
        return 'Just now';
    }

    function renderFeedCard(ev, repostEv, ctx) {
        ctx = ctx || {};
        if (!ev || !ev.id) return null;
        if (!ctx.container) return null;
        if (!ctx.document && global.document) ctx.document = global.document;
        if (!ctx.document) return null;
        if (!ctx.profileCache) ctx.profileCache = {};
        if (!ctx.eventsCache) ctx.eventsCache = {};
        if (!ctx.myBookmarks) ctx.myBookmarks = new Set();
        if (!ctx.myFollowing) ctx.myFollowing = new Set();
        if (typeof ctx.initMetrics !== 'function') ctx.initMetrics = function () {};
        if (typeof ctx.requestMetrics !== 'function') ctx.requestMetrics = function () {};
        if (typeof ctx.injectZapControls !== 'function') ctx.injectZapControls = function () {};
        if (typeof ctx.requestProfileInfo !== 'function') ctx.requestProfileInfo = function () {};
        if (typeof ctx.updateMetricsUI !== 'function') ctx.updateMetricsUI = function () {};

            let renderId = repostEv ? repostEv.id : ev.id;
            if (ctx.document.getElementById(`post-${renderId}`)) return;
            
            // Unexpired check through the shared module; the badge itself comes
            // from NostrPulseEvent.describe() further down.
            if (window.NostrPulseEvent && NostrPulseEvent.isExpired(ev)) return;

            /* NIP-36 rule lives in assets/nostr-card.js. */
            const warning = window.NostrCard ? NostrCard.contentWarning(ev) : { isNSFW: false, reason: 'NSFW' };
            let isNSFW = warning.isNSFW; let nsfwReason = warning.reason;

            ctx.initMetrics(ev.id); ctx.requestMetrics(ev.id);
            let shortPub = ev.pubkey.substring(0, 4).toUpperCase();
            let info = ctx.profileCache[ev.pubkey];
            if (!info || info.pending) info = { name: `Node_${shortPub}`, handle: `@${ev.pubkey.substring(0, 8)}`, nip05: "", picture: null };

            let avatarHtml = info.picture ? `<img src="${escapeHtml(info.picture)}" alt="Avatar">` : `[${shortPub}]`;
            let timeStr = timeAgo(ev.created_at);
            const meta = window.NostrCard ? NostrCard.eventMeta(ev) : { clientName: 'unknown', dTag: '' };
            let clientName = meta.clientName; let dTagValue = meta.dTag;

            // The pulse rule and its label both come from
            // /assets/nostr-pulse-event.js, so no page owns a copy any more.
            const pulseInfo = window.NostrPulseEvent
                ? NostrPulseEvent.describe(ev)
                : { isPulse: false, hasExpiration: false, label: '' };
            let expTimeStr = pulseInfo.label;

            const payload = window.NostrCard ? NostrCard.jsonPayload(ev) : { isJson: false, pretty: '' };
            let isJsonPayload = payload.isJson; let parsedJsonContent = payload.pretty;
            
            let isPulse = pulseInfo.isPulse;
            let isMine = (ctx.pubkey && ev.pubkey === ctx.pubkey);
            let editBtnVisibility = isMine ? '' : 'hidden';
            let bmText = ctx.myBookmarks.has(ev.id) ? '[b] saved' : '[b] save';
            let blurClass = isNSFW ? 't-spoiler' : '';
            let nsfwBadgeHtml = isNSFW ? `<div class="t-badge text-success mb-2">> CONTENT_WARNING: ${escapeHtml(nsfwReason)}</div>` : "";

            let card = ctx.document.createElement('div'); card.id = `post-${renderId}`;
            card.dataset.time = repostEv ? repostEv.created_at : ev.created_at;
            card.dataset.author = repostEv ? repostEv.pubkey : ev.pubkey;
            if (ctx.myFollowing.has(card.dataset.author)) card.classList.add('is-followed');

            let repostHtml = "";
            if (repostEv) {
                /* Ask for the reposter's profile too. This path used to read the
                   cache only, so a reposteer whose name was not already loaded
                   stayed "Node_XXXX" even though the profile exists on the
                   indexes (measured: c6ff8f15 was on three relays and never
                   requested). */
                ctx.requestProfileInfo(repostEv.pubkey);
                let rpInfo = window.NostrProfile ? window.NostrProfile.displayProfile(ctx.profileCache[repostEv.pubkey], repostEv.pubkey) : (ctx.profileCache[repostEv.pubkey] || { name: repostEv.pubkey.substring(0,8) });
                repostHtml = `<div class="text-success fs-small mb-2">> ♻️ REPOSTED BY: <a href="profile.html?pubkey=${repostEv.pubkey}" class="author-${repostEv.pubkey}" style="color:inherit; text-decoration:none;">${escapeHtml(rpInfo.name)}</a></div>`;
            }
            card.className = 't-feed-card';

            if (window.NostrMediaEvent.isMedia(ev)) {
                if (ctx.myFollowing.has(card.dataset.author)) card.classList.add('is-followed');

                /* NIP-68 pictures and NIP-71 videos keep their media in imeta
                   tags, not in content. The shared module ranks the variants
                   (a video may list several resolutions plus separate audio)
                   and draws the right one. */
                let mediaHtml = window.NostrMediaEvent.mediaHtml(ev, {
                    extraClass: blurClass,
                    /* Same rule as the kind-1 grid: while a note is concealed
                       the first click only lifts the blur (guard), and the
                       wrapper itself carries the handler that does it. */
                    guard: "if(this.parentNode.classList.contains('t-spoiler')) return; ",
                    wrapperAttrs: blurClass ? `onclick="this.classList.remove('t-spoiler'); event.stopPropagation();"` : '',
                    spoilerRemove: true,
                    fallbackText: 'Your browser does not support this video format (possibly H.265/HEVC).'
                });

                let titleStr = window.NostrMediaEvent.title(ev) ? `<div class="t-feed-content mt-2 ${blurClass}"><strong>${escapeHtml(window.NostrMediaEvent.title(ev))}</strong></div>` : "";
                let contentText = titleStr + (window.NostrMediaEvent.caption(ev) ? `<div class="t-feed-content mt-2 ${blurClass}" onclick="this.classList.remove('t-spoiler'); this.style.cursor='text';">${escapeHtml(window.NostrMediaEvent.caption(ev))}</div>` : "");
                let badgeName = window.NostrMediaEvent.badge(ev) || "MEDIA";

                card.innerHTML = `
                    <a href="profile.html?pubkey=${ev.pubkey}" class="t-avatar avatar-${ev.pubkey}" style="text-decoration:none;">${avatarHtml}</a>
                    <div class="t-feed-main">
                        ${repostHtml}
                        <div class="t-feed-header">
                            <a href="profile.html?pubkey=${ev.pubkey}" class="t-feed-author author-${ev.pubkey}">${escapeHtml(info.name)}</a>
                            <span class="t-feed-meta"><span class="handle-${ev.pubkey}">${escapeHtml(info.handle)}</span> · ${timeStr}</span>
                        </div>
                        ${nsfwBadgeHtml}
                        <div class="t-badge mt-2">> ${badgeName} / MEDIA</div>
                        ${contentText}
                        ${mediaHtml}
                        <div class="t-feed-actions mt-2">
                            <a href="thread.html?id=${ev.id}" class="t-feed-btn text-success" title="Reply">[r] <span id="metric-replies-${ev.id}">0</span></a>
                            <button id="bm-btn-${ev.id}" class="t-feed-btn text-success bookmark-btn" title="Bookmark" data-id="${ev.id}" onclick="toggleBookmark('${ev.id}')">${bmText}</button>
                            <button class="t-feed-btn text-success" title="Repost" onclick="repostEvent('${ev.id}')">[t] <span id="metric-reposts-${ev.id}">0</span></button>
                            <button class="t-feed-btn text-success" title="Like" onclick="likeEvent('${ev.id}')">[+] <span id="metric-likes-${ev.id}">0</span></button>
                            <button class="t-feed-btn text-success" title="Quote" onclick="openQuoteModal('${ev.id}')">[q]</button>
                            <button class="t-feed-btn text-success" title="View Raw Data" onclick="openRawModal('${ev.id}')">[raw]</button>
                            <button class="t-feed-btn text-success" data-report-target="${ev.id}" title="Report this event (NIP-56)" onclick="openReportModal('${ev.id}')">[report]</button>
                            <button class="t-feed-btn text-success" title="Copy Link" onclick="copyThreadLink('${ev.id}')">[link]</button>
                        </div>
                        <div class="text-right fs-small text-muted mt-2">> ${escapeHtml(window.NostrMediaEvent.eventType(ev) || 'media')} / via ${escapeHtml(clientName)}</div>
                    </div>
                `;
            }
            else if (ev.kind === 30023) {
                if (ctx.myFollowing.has(card.dataset.author)) card.classList.add('is-followed');
                
                let title = "Untitled Article"; let summary = ""; let coverImg = "";
                ev.tags.forEach(t => { if (t[0] === "title") title = t[1]; if (t[0] === "summary") summary = t[1]; if (t[0] === "image") coverImg = t[1]; });

                let coverHtml = coverImg ? `<div class="t-media-item w-100 ${blurClass}" onclick="if(this.classList.contains('t-spoiler')){this.classList.remove('t-spoiler'); event.stopPropagation();} else {openLightbox('${coverImg}');}"><img src="${coverImg}" alt="Cover Article"></div>` : "";
                let articleTargetParam = dTagValue ? `d=${encodeURIComponent(dTagValue)}&author=${ev.pubkey}` : `id=${ev.id}`;
                let finalSummaryHtml = `<div class="t-feed-content mt-2 ${blurClass}" onclick="this.classList.remove('t-spoiler'); this.style.cursor='text';">${escapeHtml(summary || ev.content.substring(0, 180) + '...')}</div>`;

                card.innerHTML = `
                    <a href="profile.html?pubkey=${ev.pubkey}" class="t-avatar avatar-${ev.pubkey}" style="text-decoration:none;">${avatarHtml}</a>
                    <div class="t-feed-main">
                        ${repostHtml}
                        <div class="t-feed-header">
                            <a href="profile.html?pubkey=${ev.pubkey}" class="t-feed-author author-${ev.pubkey}">${escapeHtml(info.name)}</a>
                            <span class="t-feed-meta"><span class="handle-${ev.pubkey}">${escapeHtml(info.handle)}</span> · ${timeStr}</span>
                        </div>
                        ${nsfwBadgeHtml}
                        <div class="font-bold fs-3 mb-2 ${blurClass}" onclick="this.classList.remove('t-spoiler'); this.style.cursor='text';">${escapeHtml(title)}</div>
                        ${coverHtml}
                        ${finalSummaryHtml}
                        <div class="t-feed-actions">
                            <a href="notes.html?${articleTargetParam}" class="t-feed-btn text-success" title="Read Article">[read]</a>
                            <button id="bm-btn-${ev.id}" class="t-feed-btn text-success bookmark-btn" title="Bookmark" data-id="${ev.id}" onclick="toggleBookmark('${ev.id}')">${bmText}</button>
                            <button class="t-feed-btn text-success" title="Copy naddr link" onclick="copyNaddr('30023', '${ev.pubkey}', '${escapeHtml(dTagValue)}')">[c] naddr</button>
                            <button class="t-feed-btn text-success" title="Repost" onclick="repostEvent('${ev.id}')">[t] <span id="metric-reposts-${ev.id}">0</span></button>
                            <button class="t-feed-btn text-success" title="Like" onclick="likeEvent('${ev.id}')">[+] <span id="metric-likes-${ev.id}">0</span></button>
                            <button class="t-feed-btn text-success" title="Quote" onclick="openQuoteModal('${ev.id}')">[q]</button>
                            <button class="t-feed-btn text-success" title="View Raw Data" onclick="openRawModal('${ev.id}')">[raw]</button>
                            <button class="t-feed-btn text-success" data-report-target="${ev.id}" title="Report this event (NIP-56)" onclick="openReportModal('${ev.id}')">[report]</button>
                            <button class="t-feed-btn text-success" title="Copy Link" onclick="copyThreadLink('${ev.id}')">[link]</button>
                            <a href="compose.html?d=${escapeHtml(dTagValue)}&author=${ev.pubkey}" class="t-feed-btn text-success edit-btn edit-btn-${ev.pubkey} ${editBtnVisibility}" title="Edit Article">[edit]</a>
                        </div>
                        <div class="text-right fs-small text-muted mt-2">> long_form / via ${escapeHtml(clientName)}</div>
                    </div>
                `;
            }
            else if (ev.kind === 1301) {
                if (ctx.myFollowing.has(card.dataset.author)) card.classList.add('is-followed');
                
                let actTitle = "Workout"; let actType = "Activity";
                let actDist = "0"; let actDistUnit = "km";
                let actDur = "00:00:00"; 
                let actEle = "0"; let actEleUnit = "m";
                
                ev.tags.forEach(t => { 
                    if (t[0] === "title") actTitle = t[1]; 
                    if (t[0] === "activity_type") actType = t[1]; 
                    if (t[0] === "distance") { actDist = t[1]; if(t[2]) actDistUnit = t[2]; }
                    if (t[0] === "duration") actDur = t[1];
                    if (t[0] === "elevation_gain") { actEle = t[1]; if(t[2]) actEleUnit = t[2]; }
                });

                let paceSpeedLabel = "Avg Pace"; let paceSpeedValue = "0:00 /km";
                try {
                    /* Pace/speed arithmetic lives in assets/nostr-card.js, where it
                       has real tests. It also carries one deliberate fix: the old
                       rounding could print "4:60" instead of "5:00" on a card. */
                    const pace = window.NostrCard
                        ? NostrCard.paceSpeed({ activityType: actType, distance: actDist, duration: actDur })
                        : null;
                    if (pace) { paceSpeedValue = pace.value; paceSpeedLabel = pace.label; }
                } catch(e) {}

                let iconStr = window.NostrCard ? NostrCard.activityIcon(actType) : "[A]";

                /* Escaping first, then linkifying: the reverse order would let a
                   crafted URL inject markup. Both live in assets/nostr-card.js. */
                let contentText = window.NostrCard ? NostrCard.renderText(ev.content) : escapeHtml(ev.content.trim());

                card.innerHTML = `
                    <a href="profile.html?pubkey=${ev.pubkey}" class="t-avatar avatar-${ev.pubkey}" style="text-decoration:none;">${avatarHtml}</a>
                    <div class="t-feed-main">
                        ${repostHtml}
                        <div class="t-feed-header">
                            <a href="profile.html?pubkey=${ev.pubkey}" class="t-feed-author text-success font-bold author-${ev.pubkey}">${escapeHtml(info.name)}</a>
                            <span class="t-feed-meta"><span class="handle-${ev.pubkey}">${escapeHtml(info.handle)}</span> · ${timeStr}</span>
                        </div>
                        ${nsfwBadgeHtml}
                        
                        <div class="t-activity-header mt-3">
                            <div class="border-dashed p-2 font-bold fs-3">${iconStr}</div>
                            <div>
                                <h4 class="t-activity-title text-success m-0">${escapeHtml(actTitle)}</h4>
                                <span class="t-activity-type text-success">${escapeHtml(actType)}</span>
                            </div>
                        </div>
                        
                        <div class="t-activity-metrics mb-2 mt-2">
                            <div class="t-metric-box w-100 mb-2">
                                <div class="t-metric-val t-metric-large">${escapeHtml(actDist)} <span class="t-metric-unit">${escapeHtml(actDistUnit)}</span></div>
                                <span class="t-metric-lbl text-success">Distance</span>
                            </div>
                            <div class="d-flex gap-3 flex-wrap">
                                <div class="t-metric-box">
                                    <div class="t-metric-val fs-2">${escapeHtml(actDur)}</div>
                                    <span class="t-metric-lbl text-success">Duration</span>
                                </div>
                                <div class="t-metric-box">
                                    <div class="t-metric-val fs-2">${escapeHtml(paceSpeedValue)}</div>
                                    <span class="t-metric-lbl text-success">${escapeHtml(paceSpeedLabel)}</span>
                                </div>
                                <div class="t-metric-box">
                                    <div class="t-metric-val fs-2">${escapeHtml(actEle)} <span class="t-metric-unit">${escapeHtml(actEleUnit)}</span></div>
                                    <span class="t-metric-lbl text-success">Elevation Gain</span>
                                </div>
                            </div>
                        </div>

                        ${contentText ? `<div class="t-feed-content ${blurClass}" onclick="this.classList.remove('t-spoiler'); this.style.cursor='text';">${contentText}</div>` : ''}
                        
                        <div class="t-feed-actions w-100 mt-2">
                            <a href="thread.html?id=${ev.id}" class="t-feed-btn text-success" title="Reply">[r] <span id="metric-replies-${ev.id}">0</span></a>
                            <button id="bm-btn-${ev.id}" class="t-feed-btn text-success bookmark-btn" title="Bookmark" data-id="${ev.id}" onclick="toggleBookmark('${ev.id}')">${bmText}</button>
                            <button class="t-feed-btn text-success" title="Repost" onclick="repostEvent('${ev.id}')">[t] <span id="metric-reposts-${ev.id}">0</span></button>
                            <button class="t-feed-btn text-success" title="Like" onclick="likeEvent('${ev.id}')">[+] <span id="metric-likes-${ev.id}">0</span></button>
                            <button class="t-feed-btn text-success" title="Quote" onclick="openQuoteModal('${ev.id}')">[q]</button>
                            <button class="t-feed-btn text-success" title="View Raw Data" onclick="openRawModal('${ev.id}')">[raw]</button>
                            <button class="t-feed-btn text-success" data-report-target="${ev.id}" title="Report this event (NIP-56)" onclick="openReportModal('${ev.id}')">[report]</button>
                            <button class="t-feed-btn text-success" title="Copy Link" onclick="copyThreadLink('${ev.id}')">[link]</button>
                        </div>
                        <div class="text-right fs-small text-muted mt-2">> tracker_data / via ${escapeHtml(clientName)}</div>
                    </div>
                `;
            }
            else {
                if (ctx.myFollowing.has(card.dataset.author)) card.classList.add('is-followed');
                
                let contentHtml = ""; let mediaHtml = "";
                let contentText = ev.content;

                if (isJsonPayload) {
                    contentHtml = `<pre class="t-code mt-2 mb-3 ${blurClass}">${escapeHtml(parsedJsonContent)}</pre>`;
                } else {
                    // The t-spoiler class and its onclick must sit on the SAME element as
                    // the media, so the attribute is passed to the assembler instead of
                    // being added as an extra wrapper, because the check inside the image would
                    // otherwise no longer find it.
                    const spoilerAttrs = `onclick="this.classList.remove('t-spoiler'); event.stopPropagation();"`;
                    // Media (images, video files, YouTube players) is assembled by one shared
                    // rule in /assets/nostr-embed.js; this used to be copied into ten places.
                    const mediaResult = (window.NostrEmbed && window.NostrEmbed.assembleMedia)
                        ? window.NostrEmbed.assembleMedia(contentText, { imeta: window.NostrImeta ? window.NostrImeta.parse(ev.tags) : null, wrap: blurClass, grid: `t-media-grid ${blurClass}`, extraAttrs: spoilerAttrs, imgGuard: "if(this.parentNode.classList.contains('t-spoiler')) return; " })
                        : { html: '', text: contentText };   // module missing: URLs stay as links
                    mediaHtml = mediaResult.html; contentText = mediaResult.text;
                    
                    // Escape, linkify bare URLs and resolve NIP-19 ids, one shared rule
                    // in /assets/nostr-note.js; this used to be copied into ten places.
                    contentText = window.NostrNote
                        ? window.NostrNote.renderContentText(contentText, ev)
                        : escapeHtml(contentText.trim());

                    contentHtml = `<div class="t-feed-content ${blurClass}" onclick="this.classList.remove('t-spoiler'); this.style.cursor='text';">${contentText}</div>`;
                }

                let pulseBadge = isPulse ? `<div class="t-badge text-success mb-2">> 24H_PULSE / ${escapeHtml(expTimeStr)}</div>` : "";

                card.innerHTML = `
                    <a href="profile.html?pubkey=${ev.pubkey}" class="t-avatar avatar-${ev.pubkey}" style="text-decoration:none;">${avatarHtml}</a>
                    <div class="t-feed-main">
                        ${repostHtml}
                        <div class="t-feed-header">
                            <a href="profile.html?pubkey=${ev.pubkey}" class="t-feed-author author-${ev.pubkey}">${escapeHtml(info.name)}</a>
                            <span class="t-feed-meta"><span class="handle-${ev.pubkey}">${escapeHtml(info.handle)}</span> · ${timeStr}</span>
                        </div>
                        ${pulseBadge}
                        ${nsfwBadgeHtml}
                        ${contentHtml}
                        ${mediaHtml}
                        <div class="t-quote-holder"></div>
                        <div class="t-feed-actions">
                            <a href="thread.html?id=${ev.id}" class="t-feed-btn text-success" title="Reply">[r] <span id="metric-replies-${ev.id}">0</span></a>
                            <button id="bm-btn-${ev.id}" class="t-feed-btn text-success bookmark-btn" title="Bookmark" data-id="${ev.id}" onclick="toggleBookmark('${ev.id}')">${bmText}</button>
                            <button class="t-feed-btn text-success" title="Repost" onclick="repostEvent('${ev.id}')">[t] <span id="metric-reposts-${ev.id}">0</span></button>
                            <button class="t-feed-btn text-success" title="Like" onclick="likeEvent('${ev.id}')">[+] <span id="metric-likes-${ev.id}">0</span></button>
                            <button class="t-feed-btn text-success" title="Quote" onclick="openQuoteModal('${ev.id}')">[q]</button>
                            <button class="t-feed-btn text-success" title="View Raw Data" onclick="openRawModal('${ev.id}')">[raw]</button>
                            <button class="t-feed-btn text-success" data-report-target="${ev.id}" title="Report this event (NIP-56)" onclick="openReportModal('${ev.id}')">[report]</button>
                            <button class="t-feed-btn text-success" title="Copy Link" onclick="copyThreadLink('${ev.id}')">[link]</button>
                            <button class="t-feed-btn text-success edit-btn edit-btn-${ev.pubkey} ${editBtnVisibility}" title="Edit Note" onclick="openEditModal('${ev.id}')">[edit]</button>
                        </div>
                        <div class="text-right fs-small text-muted mt-2">> ${isPulse ? 'pulse_event' : (isJsonPayload ? 'telemetry_data' : 'text_note')} / via ${escapeHtml(clientName)}</div>
                    </div>
                `;
            }

            let evTime = repostEv ? repostEv.created_at : ev.created_at;
            let children = ctx.container.children;
            let inserted = false;
            for (let i = 0; i < children.length; i++) {
                if (parseInt(children[i].dataset.time) < evTime) {
                    ctx.container.insertBefore(card, children[i]);
                    inserted = true;
                    break;
                }
            }
            if (!inserted) ctx.container.appendChild(card);
            /* NIP-27: linkify nostr: mentions inside this card. */
            if (window.NostrNip27) window.NostrNip27.upgrade(card);
            
            ctx.injectZapControls(card, ev);
            ctx.updateMetricsUI(ev.id);

            if (window.NostrNote) {
                // NIP-18: if this note quotes another note, show its card. If the note
                // is not found, nothing is mounted and the original note stays intact.
                window.NostrNote.mountQuotes(card.querySelector('.t-quote-holder'), ev, {
                    get: (id) => ctx.eventsCache[id],
                    load: (id, relay) => window.NostrNote.fetchEventById(id, null, relay ? [relay] : null),
                    onEvent: (qev) => {
                        ctx.eventsCache[qev.id] = qev;
                        if (!ctx.profileCache[qev.pubkey]) ctx.requestProfileInfo(qev.pubkey);
                    },
                    after: () => window.NostrNote.upgradeLinks(card.querySelector('.t-quote-holder'))
                });
                // GitHub link previews. If the request fails (rate limit reached, for
                // example), the original link is left unchanged.
                window.NostrNote.upgradeLinks(card);
            }
        
        return card;
    }

    var api = { renderFeedCard: renderFeedCard };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.NostrFeedCard = api;
})(typeof window !== 'undefined' ? window : globalThis);
