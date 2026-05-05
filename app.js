/**
 * Toxic Releases Near You — Frontend
 *
 * Architecture:
 *   stats.json       — loaded immediately (small, national overview)
 *   facilities.json  — loaded on first search (~2-4MB, all ~21K facilities)
 *   zips.json        — loaded on first search (~1MB, ZIP centroid lookup)
 *   chemicals/{ST}.json — loaded on demand when user clicks a facility
 *
 * Facility array format: [trifd, name, city, state, zip, lat, lon, industry,
 *   total_lbs, air_lbs, water_lbs, num_chemicals, num_carcinogens, num_pbts,
 *   num_pfas, parent_company]
 *
 * Chemical array format: [trifd, chemical, cas_number, carcinogen, pbt, pfas,
 *   air_lbs, water_lbs, total_lbs]
 */

(function () {
    'use strict';

    // Data caches
    let stats = null;
    let facilities = null;
    let zipLookup = null;
    const chemCache = {}; // state -> chemical data
    let lastResults = null;

    // DOM refs
    const zipInput = document.getElementById('zip-input');
    const radiusSelect = document.getElementById('radius-select');
    const searchBtn = document.getElementById('search-btn');
    const searchStatus = document.getElementById('search-status');
    const resultsSection = document.getElementById('results-section');
    const resultsSummary = document.getElementById('results-summary');
    const resultsList = document.getElementById('results-list');
    const detailSection = document.getElementById('detail-section');
    const facilityDetail = document.getElementById('facility-detail');
    const backBtn = document.getElementById('back-btn');
    const statsSection = document.getElementById('stats-section');
    const statsGrid = document.getElementById('stats-grid');
    const topChemicals = document.getElementById('top-chemicals');
    const topIndustries = document.getElementById('top-industries');

    // -------------------------------------------------------
    // Utilities
    // -------------------------------------------------------

    function fmt(n) {
        if (n == null || isNaN(n)) return '0';
        if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return Math.round(n).toLocaleString();
        return String(Math.round(n));
    }

    function fmtLbs(n) {
        if (!n) return '0 lbs';
        return fmt(n) + ' lbs';
    }

    /** Haversine distance in miles between two lat/lon points */
    function haversine(lat1, lon1, lat2, lon2) {
        const R = 3959; // Earth radius in miles
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) *
            Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /** Unpack compact facility array */
    function unpackFacility(arr) {
        return {
            trifd: arr[0] || '',
            name: arr[1] || 'Unknown Facility',
            city: arr[2] || '',
            state: arr[3] || '',
            zip: arr[4] || '',
            lat: arr[5] || 0,
            lon: arr[6] || 0,
            industry: arr[7] || '',
            totalLbs: arr[8] || 0,
            airLbs: arr[9] || 0,
            waterLbs: arr[10] || 0,
            numChemicals: arr[11] || 0,
            numCarcinogens: arr[12] || 0,
            numPbts: arr[13] || 0,
            numPfas: arr[14] || 0,
            parentCompany: arr[15] || '',
        };
    }

    /** Unpack compact chemical array */
    function unpackChemical(arr) {
        return {
            trifd: arr[0] || '',
            chemical: arr[1] || '',
            cas: arr[2] || '',
            carcinogen: arr[3] || 0,
            pbt: arr[4] || 0,
            pfas: arr[5] || 0,
            airLbs: arr[6] || 0,
            waterLbs: arr[7] || 0,
            totalLbs: arr[8] || 0,
        };
    }

    async function fetchJSON(path) {
        const res = await fetch(path);
        if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
        return res.json();
    }

    // -------------------------------------------------------
    // Data loading
    // -------------------------------------------------------

    async function loadStats() {
        if (stats) return stats;
        stats = await fetchJSON('data/stats.json');
        return stats;
    }

    async function loadFacilities() {
        if (facilities) return facilities;
        searchStatus.textContent = 'Loading facility data...';
        searchStatus.className = 'loading';
        facilities = await fetchJSON('data/facilities.json');
        return facilities;
    }

    async function loadZips() {
        if (zipLookup) return zipLookup;
        zipLookup = await fetchJSON('data/zips.json');
        return zipLookup;
    }

    async function loadChemicals(state) {
        if (chemCache[state]) return chemCache[state];
        const data = await fetchJSON(`data/chemicals/${state}.json`);
        chemCache[state] = data;
        return data;
    }

    // -------------------------------------------------------
    // Search
    // -------------------------------------------------------

    async function doSearch() {
        const zip = zipInput.value.trim();
        if (!/^\d{5}$/.test(zip)) {
            searchStatus.textContent = 'Enter a 5-digit ZIP code.';
            searchStatus.className = '';
            return;
        }

        searchBtn.disabled = true;
        searchStatus.textContent = 'Loading data...';
        searchStatus.className = 'loading';

        try {
            // Load both datasets in parallel
            const [fac, zips] = await Promise.all([loadFacilities(), loadZips()]);

            const centroid = zips[zip];
            if (!centroid) {
                searchStatus.textContent = `ZIP code ${zip} not found in Census data.`;
                searchStatus.className = '';
                searchBtn.disabled = false;
                return;
            }

            const [userLat, userLon] = centroid;
            const radius = parseFloat(radiusSelect.value);

            searchStatus.textContent = 'Searching nearby facilities...';

            // Quick bounding box filter first (much faster than haversine for all 21K)
            const latDeg = radius / 69.0; // ~69 miles per degree latitude
            const lonDeg = radius / (69.0 * Math.cos(userLat * Math.PI / 180));
            const minLat = userLat - latDeg;
            const maxLat = userLat + latDeg;
            const minLon = userLon - lonDeg;
            const maxLon = userLon + lonDeg;

            const results = [];
            for (const arr of fac) {
                const lat = arr[5] || 0;
                const lon = arr[6] || 0;

                // Bounding box prefilter
                if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) continue;

                // Precise haversine
                const dist = haversine(userLat, userLon, lat, lon);
                if (dist <= radius) {
                    results.push({ arr, dist });
                }
            }

            // Sort by distance
            results.sort((a, b) => a.dist - b.dist);

            lastResults = results;
            renderResults(zip, radius, userLat, userLon, results);

        } catch (err) {
            searchStatus.textContent = `Error: ${err.message}`;
            searchStatus.className = '';
        }

        searchBtn.disabled = false;
    }

    // -------------------------------------------------------
    // Results rendering
    // -------------------------------------------------------

    function renderResults(zip, radius, lat, lon, results) {
        detailSection.classList.add('hidden');
        resultsSection.classList.remove('hidden');
        statsSection.classList.add('hidden');

        // Summary
        const totalReleases = results.reduce((s, r) => s + (r.arr[8] || 0), 0);
        const carcCount = results.filter(r => (r.arr[12] || 0) > 0).length;
        const pfasCount = results.filter(r => (r.arr[14] || 0) > 0).length;

        let summaryHTML = `<h2>${results.length.toLocaleString()} facilit${results.length === 1 ? 'y' : 'ies'} within ${radius} miles of ${zip}</h2>`;
        summaryHTML += `<div class="results-meta">`;
        summaryHTML += `Total reported releases: <strong>${fmtLbs(totalReleases)}</strong>`;
        if (carcCount) summaryHTML += ` &middot; <span style="color:var(--carc)">${carcCount} releasing carcinogens</span>`;
        if (pfasCount) summaryHTML += ` &middot; <span style="color:var(--pfas)">${pfasCount} releasing PFAS</span>`;
        summaryHTML += `</div>`;
        resultsSummary.innerHTML = summaryHTML;

        if (results.length === 0) {
            resultsList.innerHTML = '<p style="color:var(--text-dim);padding:1rem;">No TRI-reporting facilities found within this radius. This does not mean the area is free of toxic releases — TRI only covers facilities meeting reporting thresholds.</p>';
            searchStatus.textContent = '';
            return;
        }

        // Facility cards
        let html = '';
        for (const r of results) {
            const f = unpackFacility(r.arr);
            html += renderFacilityCard(f, r.dist);
        }
        resultsList.innerHTML = html;
        searchStatus.textContent = '';

        // Attach click handlers
        resultsList.querySelectorAll('.facility-card').forEach(card => {
            card.addEventListener('click', () => {
                const idx = parseInt(card.dataset.idx, 10);
                showDetail(results[idx]);
            });
        });
    }

    function renderFacilityCard(f, dist) {
        let badges = '';
        if (f.numCarcinogens > 0) badges += `<span class="badge badge-carc">${f.numCarcinogens} carcinogen${f.numCarcinogens > 1 ? 's' : ''}</span>`;
        if (f.numPbts > 0) badges += `<span class="badge badge-pbt">${f.numPbts} PBT${f.numPbts > 1 ? 's' : ''}</span>`;
        if (f.numPfas > 0) badges += `<span class="badge badge-pfas">PFAS</span>`;

        const idx = lastResults.findIndex(r => r.arr[0] === f.trifd);

        return `
        <div class="facility-card" data-idx="${idx}">
            <div class="facility-header">
                <span class="facility-name">${esc(f.name)}</span>
                <span class="facility-distance">${dist.toFixed(1)} mi</span>
            </div>
            <div class="facility-location">${esc(f.city)}, ${esc(f.state)} ${esc(f.zip)} &middot; ${esc(f.industry)}</div>
            <div class="facility-stats">
                <div class="facility-stat"><span class="label">Released:</span> <span class="value">${fmtLbs(f.totalLbs)}</span></div>
                <div class="facility-stat"><span class="label">Air:</span> <span class="value" style="color:var(--air)">${fmtLbs(f.airLbs)}</span></div>
                <div class="facility-stat"><span class="label">Water:</span> <span class="value" style="color:var(--water)">${fmtLbs(f.waterLbs)}</span></div>
                <div class="facility-stat"><span class="label">Chemicals:</span> <span class="value">${f.numChemicals}</span></div>
            </div>
            ${badges ? `<div class="badges">${badges}</div>` : ''}
        </div>`;
    }

    // -------------------------------------------------------
    // Facility detail view
    // -------------------------------------------------------

    async function showDetail(result) {
        const f = unpackFacility(result.arr);

        resultsSection.classList.add('hidden');
        detailSection.classList.remove('hidden');

        let html = `<div class="detail-header">
            <h2>${esc(f.name)}</h2>
            <div class="location">${esc(f.city)}, ${esc(f.state)} ${esc(f.zip)}${f.parentCompany ? ' &middot; ' + esc(f.parentCompany) : ''}</div>
            <div class="location">${esc(f.industry)} &middot; ${result.dist.toFixed(1)} miles away &middot; TRI ID: ${esc(f.trifd)}</div>
            <div class="detail-stats">
                <div class="detail-stat"><div class="label">Total Released</div><div class="value">${fmtLbs(f.totalLbs)}</div></div>
                <div class="detail-stat"><div class="label">Air Releases</div><div class="value air">${fmtLbs(f.airLbs)}</div></div>
                <div class="detail-stat"><div class="label">Water Releases</div><div class="value water">${fmtLbs(f.waterLbs)}</div></div>
                <div class="detail-stat"><div class="label">Chemicals</div><div class="value">${f.numChemicals}</div></div>
                ${f.numCarcinogens ? `<div class="detail-stat"><div class="label">Carcinogens</div><div class="value danger">${f.numCarcinogens}</div></div>` : ''}
                ${f.numPbts ? `<div class="detail-stat"><div class="label">Persistent Bioaccumulative Toxics</div><div class="value" style="color:var(--pbt)">${f.numPbts}</div></div>` : ''}
                ${f.numPfas ? `<div class="detail-stat"><div class="label">PFAS ("Forever Chemicals")</div><div class="value" style="color:var(--pfas)">${f.numPfas}</div></div>` : ''}
            </div>
        </div>`;

        html += `<div class="chemicals-table"><h3>Chemicals Released</h3><div id="chem-loading" style="padding:0.75rem;color:var(--text-dim);">Loading chemical details...</div></div>`;
        facilityDetail.innerHTML = html;

        // Load chemical details for this state
        try {
            const chemData = await loadChemicals(f.state);
            const facilityChems = chemData
                .map(unpackChemical)
                .filter(c => c.trifd === f.trifd)
                .sort((a, b) => (b.totalLbs || 0) - (a.totalLbs || 0));

            if (facilityChems.length === 0) {
                document.getElementById('chem-loading').textContent = 'No chemical details available.';
                return;
            }

            let tableHTML = `<table>
                <thead><tr>
                    <th>Chemical</th>
                    <th>CAS #</th>
                    <th>Flags</th>
                    <th class="num">Air (lbs)</th>
                    <th class="num">Water (lbs)</th>
                    <th class="num">Total (lbs)</th>
                </tr></thead><tbody>`;

            for (const c of facilityChems) {
                let flags = '';
                if (c.carcinogen) flags += '<span class="badge badge-carc">CARC</span> ';
                if (c.pbt) flags += '<span class="badge badge-pbt">PBT</span> ';
                if (c.pfas) flags += '<span class="badge badge-pfas">PFAS</span> ';

                tableHTML += `<tr>
                    <td>${esc(c.chemical)}</td>
                    <td style="color:var(--text-muted)">${esc(c.cas)}</td>
                    <td>${flags}</td>
                    <td class="num">${fmt(c.airLbs)}</td>
                    <td class="num">${fmt(c.waterLbs)}</td>
                    <td class="num"><strong>${fmt(c.totalLbs)}</strong></td>
                </tr>`;
            }
            tableHTML += '</tbody></table>';

            const chemTable = facilityDetail.querySelector('.chemicals-table');
            chemTable.innerHTML = `<h3>Chemicals Released (${facilityChems.length})</h3>` + tableHTML;

        } catch (err) {
            document.getElementById('chem-loading').textContent = `Failed to load chemical details: ${err.message}`;
        }
    }

    function esc(s) {
        if (!s) return '';
        const div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }

    // -------------------------------------------------------
    // Stats rendering (landing page)
    // -------------------------------------------------------

    function renderStats(s) {
        // Hero cards
        statsGrid.innerHTML = `
            <div class="stat-card"><div class="value accent">${fmt(s.total_facilities)}</div><div class="label">Reporting Facilities</div></div>
            <div class="stat-card"><div class="value">${fmt(s.total_chemicals)}</div><div class="label">Toxic Chemicals</div></div>
            <div class="stat-card"><div class="value">${fmtLbs(s.total_releases_lbs)}</div><div class="label">Total Releases</div></div>
            <div class="stat-card"><div class="value" style="color:var(--air)">${fmtLbs(s.total_air_lbs)}</div><div class="label">Air Releases</div></div>
            <div class="stat-card"><div class="value" style="color:var(--water)">${fmtLbs(s.total_water_lbs)}</div><div class="label">Water Releases</div></div>
            <div class="stat-card"><div class="value" style="color:var(--carc)">${fmt(s.carcinogen_facilities)}</div><div class="label">Facilities Releasing Carcinogens</div></div>
            <div class="stat-card"><div class="value" style="color:var(--pfas)">${fmt(s.pfas_facilities)}</div><div class="label">Facilities Releasing PFAS</div></div>
            <div class="stat-card"><div class="value" style="color:var(--pbt)">${fmt(s.pbt_facilities)}</div><div class="label">Facilities Releasing PBTs</div></div>
        `;

        // Top chemicals
        if (s.top_chemicals && s.top_chemicals.length) {
            const maxR = s.top_chemicals[0].r;
            let html = '<h3>Top Chemicals by Total Release</h3>';
            for (const c of s.top_chemicals.slice(0, 15)) {
                const pct = (c.r / maxR * 100).toFixed(1);
                const isCarc = c.c ? ' carc' : '';
                let flagStr = '';
                if (c.c) flagStr += ' <span class="badge badge-carc">CARC</span>';
                if (c.p) flagStr += ' <span class="badge badge-pbt">PBT</span>';
                html += `<div class="bar-row">
                    <span class="bar-label" title="${esc(c.n)}">${esc(c.n)}${flagStr}</span>
                    <div class="bar-track"><div class="bar-fill${isCarc}" style="width:${pct}%"></div></div>
                    <span class="bar-value">${fmtLbs(c.r)}</span>
                </div>`;
            }
            topChemicals.innerHTML = html;
        }

        // Top industries
        if (s.top_industries && s.top_industries.length) {
            const maxR = s.top_industries[0].r;
            let html = '<h3>Top Industries by Total Release</h3>';
            for (const ind of s.top_industries.slice(0, 10)) {
                const pct = (ind.r / maxR * 100).toFixed(1);
                html += `<div class="bar-row">
                    <span class="bar-label">${esc(ind.n)} (${fmt(ind.f)})</span>
                    <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
                    <span class="bar-value">${fmtLbs(ind.r)}</span>
                </div>`;
            }
            topIndustries.innerHTML = html;
        }
    }

    // -------------------------------------------------------
    // Event handling
    // -------------------------------------------------------

    zipInput.addEventListener('input', () => {
        const v = zipInput.value.replace(/\D/g, '').slice(0, 5);
        zipInput.value = v;
        searchBtn.disabled = v.length < 5;
    });

    zipInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !searchBtn.disabled) doSearch();
    });

    searchBtn.addEventListener('click', doSearch);

    backBtn.addEventListener('click', () => {
        detailSection.classList.add('hidden');
        resultsSection.classList.remove('hidden');
    });

    // -------------------------------------------------------
    // Init
    // -------------------------------------------------------

    loadStats()
        .then(renderStats)
        .catch(err => {
            statsGrid.innerHTML = `<p style="color:var(--text-dim)">Could not load statistics: ${err.message}</p>`;
        });

    zipInput.focus();

})();
