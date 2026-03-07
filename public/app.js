// Constants for Node Colors
const COLORS = {
    MAINNET: '#10b981',
    L2: '#8b5cf6',
    TESTNET: '#f59e0b',
    BEACON: '#ec4899',
    DEFAULT: '#6b7280'
};

// Global State
let graphData = { nodes: [], links: [] };
let filteredData = { nodes: [], links: [] };
let currentFilter = 'all';
let myGraph = null;

// ─── Utility: Debounce ───
function debounce(fn, ms) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

// ─── Utility: Highlight matching text safely using DOM (no innerHTML) ───
function highlightText(container, text, query) {
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const idx = lowerText.indexOf(lowerQuery);

    if (idx === -1 || !query) {
        container.textContent = text;
        return;
    }

    // Before match
    if (idx > 0) {
        container.appendChild(document.createTextNode(text.slice(0, idx)));
    }
    // Match (bold)
    const strong = document.createElement('strong');
    strong.textContent = text.slice(idx, idx + query.length);
    container.appendChild(strong);
    // After match
    if (idx + query.length < text.length) {
        container.appendChild(document.createTextNode(text.slice(idx + query.length)));
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    initUI();
    fetchData();
});

function initUI() {
    // Filter Buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const target = e.currentTarget;
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            target.classList.add('active');
            currentFilter = target.dataset.filter;
            applyFilters();
        });
    });

    // Search Logic
    const searchInput = document.getElementById('searchInput');
    const searchDropdown = document.getElementById('searchDropdown');
    let activeDropdownIndex = -1;

    globalThis.searchAndFocus = (query) => {
        const q = String(query).toLowerCase().trim();
        if (!q) return;

        const node = graphData.nodes.find(n =>
            n.id.toString() === q ||
            n.name.toLowerCase() === q ||
            (n.data.shortName?.toLowerCase() === q) ||
            (n.data.chain?.toLowerCase() === q) ||
            n.name.toLowerCase().includes(q)
        );

        if (node) {
            searchInput.value = node.name;
            searchDropdown.classList.add('hidden');
            focusNode(node);
        }
    };

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-box')) {
            searchDropdown.classList.add('hidden');
        }
    });

    // Keyboard shortcut: "/" to focus search
    document.addEventListener('keydown', (e) => {
        if (e.key === '/' && document.activeElement !== searchInput) {
            e.preventDefault();
            searchInput.focus();
        }
        if (e.key === 'Escape') {
            searchDropdown.classList.add('hidden');
            searchInput.blur();
        }
    });

    // Debounced search to avoid excessive DOM rebuilds
    const handleSearch = debounce((query) => {
        if (!query) {
            searchDropdown.classList.add('hidden');
            return;
        }

        const matches = graphData.nodes.filter(n =>
            n.name.toLowerCase().includes(query) ||
            n.id.toString().includes(query) ||
            (n.data.shortName?.toLowerCase().includes(query)) ||
            (n.data.chain?.toLowerCase().includes(query)) ||
            (n.data.tags?.some(t => t.toLowerCase().includes(query)))
        );

        // Sort: exact/prefix matches first
        matches.sort((a, b) => {
            const aName = a.name.toLowerCase();
            const bName = b.name.toLowerCase();
            const aStarts = aName.startsWith(query);
            const bStarts = bName.startsWith(query);
            if (aStarts !== bStarts) return aStarts ? -1 : 1;
            const aInName = aName.includes(query);
            const bInName = bName.includes(query);
            if (aInName !== bInName) return aInName ? -1 : 1;
            return aName.localeCompare(bName);
        });

        const topMatches = matches.slice(0, 50);
        activeDropdownIndex = -1;

        // Build dropdown using DocumentFragment for performance
        const fragment = document.createDocumentFragment();

        if (topMatches.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'dropdown-empty';
            empty.textContent = 'No chains found.';
            fragment.appendChild(empty);
        } else {
            for (const node of topMatches) {
                const item = document.createElement('div');
                item.className = 'dropdown-item';
                item.dataset.nodeId = node.id;

                const icon = document.createElement('div');
                icon.className = 'dropdown-icon';
                icon.style.background = `linear-gradient(135deg, ${node.color}, ${node.color}44)`;
                icon.textContent = node.name ? node.name.charAt(0).toUpperCase() : '?';

                const info = document.createElement('div');
                info.className = 'dropdown-info';

                const nameSpan = document.createElement('span');
                nameSpan.className = 'dropdown-name';
                highlightText(nameSpan, node.name, query);

                const meta = document.createElement('div');
                meta.className = 'dropdown-meta';
                const tagsList = node.data.tags?.length > 0 ? node.data.tags.join(', ') : node.type;
                meta.textContent = `ID: ${node.id}  \u00b7  ${tagsList}`;

                info.appendChild(nameSpan);
                info.appendChild(meta);
                item.appendChild(icon);
                item.appendChild(info);

                item.addEventListener('click', () => searchAndFocus(node.id));
                fragment.appendChild(item);
            }
        }

        searchDropdown.textContent = '';
        searchDropdown.appendChild(fragment);
        searchDropdown.classList.remove('hidden');
    }, 150);

    searchInput.addEventListener('input', (e) => {
        handleSearch(e.target.value.toLowerCase().trim());
    });

    // Keyboard navigation in dropdown
    searchInput.addEventListener('keydown', (e) => {
        const items = searchDropdown.querySelectorAll('.dropdown-item');
        if (!items.length) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            activeDropdownIndex = Math.min(activeDropdownIndex + 1, items.length - 1);
            updateActiveItem(items);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            activeDropdownIndex = Math.max(activeDropdownIndex - 1, 0);
            updateActiveItem(items);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (activeDropdownIndex >= 0 && items[activeDropdownIndex]) {
                const nodeId = items[activeDropdownIndex].dataset.nodeId;
                searchAndFocus(nodeId);
            } else {
                searchAndFocus(searchInput.value);
            }
        }
    });

    function updateActiveItem(items) {
        items.forEach((item, i) => {
            item.classList.toggle('active', i === activeDropdownIndex);
        });
        if (items[activeDropdownIndex]) {
            items[activeDropdownIndex].scrollIntoView({ block: 'nearest' });
        }
    }

    // Close Details Panel
    const closeBtn = document.getElementById('closeDetails');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            document.getElementById('detailsPanel')?.classList.add('hidden');
        });
    }
}

async function fetchExportData() {
    let res;
    try {
        res = await fetch('/export');
        if (!res.ok) throw new Error('Local export unavailable');
    } catch {
        res = await fetch('export.json');
    }
    return res.json();
}

function buildRelationsMap(chains) {
    const relations = {};
    for (const chain of chains) {
        if (!chain.relations) continue;
        for (const rel of chain.relations) {
            addRelation(relations, rel, chain);
        }
    }
    return relations;
}

function addRelation(relations, rel, chain) {
    if (rel.kind === 'l2Of') {
        if (!relations[rel.chainId]) relations[rel.chainId] = {};
        relations[rel.chainId][chain.chainId] = { kind: 'l2Of' };
    } else if (rel.kind === 'testnetOf') {
        if (!relations[rel.chainId]) relations[rel.chainId] = {};
        relations[rel.chainId][chain.chainId] = { kind: 'testnetOf' };
    } else if (rel.kind === 'mainnetOf') {
        if (!relations[chain.chainId]) relations[chain.chainId] = {};
        relations[chain.chainId][rel.chainId] = { kind: 'testnetOf' };
    }
}

async function fetchData() {
    try {
        const exportData = await fetchExportData();
        const chains = exportData.data.indexed.all;
        const relations = buildRelationsMap(chains);

        processGraphData(chains, relations);
        updateStats();
        document.getElementById('loadingOverlay').classList.add('hidden');
        renderGraph();
    } catch (error) {
        console.error('Error fetching data:', error);
        const overlay = document.getElementById('loadingOverlay');
        overlay.querySelector('.spinner').style.display = 'none';
        overlay.querySelector('p').textContent = 'Failed to load data.';
        overlay.querySelector('.loading-sub').textContent = 'Check your connection or ensure the API is running.';
    }
}

function updateStats() {
    const total = graphData.nodes.length;
    const mainnets = graphData.nodes.filter(n => n.type === 'Mainnet').length;
    const l2s = graphData.nodes.filter(n => n.type === 'L2').length;
    const testnets = graphData.nodes.filter(n => n.type === 'Testnet').length;

    const statsEl = document.getElementById('statsLine');
    statsEl.textContent = `${total} chains \u00b7 ${mainnets} mainnets \u00b7 ${l2s} L2s \u00b7 ${testnets} testnets`;
}

function classifyChain(c) {
    if (c.tags?.includes('Beacon')) return { type: 'Beacon', color: COLORS.BEACON, val: 1.5 };
    if (c.tags?.includes('L2')) return { type: 'L2', color: COLORS.L2, val: 1.8 };
    if (c.tags?.includes('Testnet')) return { type: 'Testnet', color: COLORS.TESTNET, val: 1 };
    return { type: 'Mainnet', color: COLORS.MAINNET, val: c.chainId === 1 ? 8 : 3 };
}

function createGraphNode(c) {
    const { type, color, val } = classifyChain(c);
    let displayName = c.name || `Chain ${c.chainId}`;
    if (c.tags?.includes('Testnet') && !displayName.toLowerCase().includes('testnet')) {
        displayName += ' Testnet';
    }
    return {
        id: c.chainId, name: displayName, val, color, type, data: c,
        parent: null, l2Parent: null, mainnetParent: null,
        children: [], l2Children: [], testnetChildren: []
    };
}

function linkRelation(parentNode, childNode, relationInfo, links) {
    links.push({ source: childNode.id, target: parentNode.id, kind: relationInfo.kind });

    if (relationInfo.kind === 'l2Of' || relationInfo.kind === 'l1Of') {
        childNode.l2Parent = parentNode;
        parentNode.l2Children.push(childNode);
    } else if (relationInfo.kind === 'testnetOf' || relationInfo.kind === 'mainnetOf') {
        childNode.mainnetParent = parentNode;
        parentNode.testnetChildren.push(childNode);
    }

    childNode.parent = parentNode;
    parentNode.children.push(childNode);
}

function processGraphData(chains, relations) {
    const nodes = [];
    const links = [];
    const nodeMap = new Map();

    for (const c of chains) {
        const node = createGraphNode(c);
        nodes.push(node);
        nodeMap.set(c.chainId, node);
    }

    for (const parentIdStr of Object.keys(relations)) {
        const parentId = Number.parseInt(parentIdStr);
        const childrenObj = relations[parentIdStr];

        for (const childIdStr of Object.keys(childrenObj)) {
            const childId = Number.parseInt(childIdStr);
            const parentNode = nodeMap.get(parentId);
            const childNode = nodeMap.get(childId);

            if (parentNode && childNode) {
                linkRelation(parentNode, childNode, childrenObj[childIdStr], links);
            }
        }
    }

    graphData = { nodes, links };
    filteredData = { nodes: [...nodes], links: [...links] };
}

function filterLinksForNodes(nodeIds, excludeKind) {
    return graphData.links.filter(l => {
        const sourceId = l.source.id ?? l.source;
        const targetId = l.target.id ?? l.target;
        return nodeIds.has(sourceId) && nodeIds.has(targetId) && (!excludeKind || l.kind !== excludeKind);
    });
}

function collectL2Tree(node, visibleNodesSet) {
    if (!node.l2Children) return;
    for (const child of node.l2Children) {
        if (visibleNodesSet.has(child) || child.data.tags?.includes('Testnet')) continue;
        visibleNodesSet.add(child);
        collectL2Tree(child, visibleNodesSet);
    }
}

function filterMainnetNodes() {
    const visibleNodesSet = new Set();
    for (const n of graphData.nodes) {
        if ((n.type === 'Mainnet' || n.type === 'Beacon') && !n.mainnetParent) {
            visibleNodesSet.add(n);
            collectL2Tree(n, visibleNodesSet);
        }
    }
    const visibleNodes = Array.from(visibleNodesSet);
    const visibleNodeIds = new Set(visibleNodes.map(n => n.id));
    return { nodes: visibleNodes, links: filterLinksForNodes(visibleNodeIds, 'testnetOf') };
}

function filterByType(type) {
    const visibleNodesSet = new Set();
    for (const n of graphData.nodes) {
        if (n.type === type) {
            visibleNodesSet.add(n);
            if (n.parent) visibleNodesSet.add(n.parent);
        }
    }
    const visibleNodes = Array.from(visibleNodesSet);
    const visibleNodeIds = new Set(visibleNodes.map(n => n.id));
    return { nodes: visibleNodes, links: filterLinksForNodes(visibleNodeIds) };
}

function applyFilters() {
    if (currentFilter === 'all') {
        filteredData = { nodes: [...graphData.nodes], links: [...graphData.links] };
    } else if (currentFilter === 'Mainnet') {
        filteredData = filterMainnetNodes();
    } else {
        filteredData = filterByType(currentFilter);
    }

    if (currentFilter === 'all') {
        updateStats();
    } else {
        document.getElementById('statsLine').textContent = `Showing ${filteredData.nodes.length} of ${graphData.nodes.length} chains`;
    }

    if (myGraph) {
        myGraph.graphData(filteredData);
    }
}

function renderGraph() {
    const elem = document.getElementById('3d-graph');

    myGraph = ForceGraph3D()(elem)
        .graphData(filteredData)
        .nodeLabel('name')
        .nodeColor('color')
        .nodeVal('val')
        .nodeResolution(12)
        .nodeOpacity(0.9)
        .linkColor(link => {
            if (link.kind === 'l2Of' || link.kind === 'l1Of') return 'rgba(139, 92, 246, 0.4)';
            if (link.kind === 'testnetOf') return 'rgba(245, 158, 11, 0.4)';
            return 'rgba(255, 255, 255, 0.1)';
        })
        .linkWidth(0.8)
        .linkDirectionalParticles(link => {
            if (link.kind === 'l2Of' || link.kind === 'l1Of' || link.kind === 'testnetOf') return 2;
            return 0;
        })
        .linkDirectionalParticleSpeed(0.004)
        .linkDirectionalParticleWidth(1.5)
        .linkDirectionalParticleColor(link => {
            if (link.kind === 'l2Of' || link.kind === 'l1Of') return 'rgba(139, 92, 246, 0.7)';
            if (link.kind === 'testnetOf') return 'rgba(245, 158, 11, 0.7)';
            return '#ffffff';
        })
        .backgroundColor('#060608')
        .warmupTicks(80)
        .cooldownTicks(60)
        .onNodeClick(node => focusNode(node))
        .onBackgroundClick(() => {
            document.getElementById('detailsPanel').classList.add('hidden');
        });
}

function focusNode(node) {
    if (!myGraph) return;

    const distance = 150;
    const distRatio = 1 + distance / Math.hypot(node.x, node.y, node.z);

    const newPos = node.x || node.y || node.z
        ? { x: node.x * distRatio, y: node.y * distRatio, z: node.z * distRatio }
        : { x: 0, y: 0, z: distance };

    myGraph.cameraPosition(newPos, node, 1200);
    showNodeDetails(node);
}

function showParentRow(rowId, elemId, parentNode) {
    const row = document.getElementById(rowId);
    const elem = document.getElementById(elemId);
    if (!row || !elem) return { row, elem };
    if (parentNode) {
        row.style.display = 'flex';
        const a = document.createElement('a');
        a.href = "#";
        a.textContent = parentNode.name;
        a.onclick = (e) => { e.preventDefault(); searchAndFocus(parentNode.id); };
        elem.textContent = '';
        elem.appendChild(a);
    } else {
        row.style.display = 'none';
        elem.textContent = '--';
    }
    return { row, elem };
}

function populateChildLinks(container, children) {
    for (const child of children) {
        const a = document.createElement('a');
        a.href = "#";
        a.textContent = child.name;
        a.onclick = (e) => { e.preventDefault(); searchAndFocus(child.id); };
        container.appendChild(a);
    }
}

function showChildrenSection(containerId, labelId, children, label) {
    const container = document.getElementById(containerId);
    const labelElem = document.getElementById(labelId);
    if (!container || !labelElem) return;
    container.textContent = '';
    if (children && children.length > 0) {
        labelElem.textContent = `${label} (${children.length})`;
        populateChildLinks(container, children);
    } else {
        labelElem.textContent = label;
        container.textContent = 'None';
    }
}

function showRpcEndpoints(data) {
    const rpcContainer = document.getElementById('chainRPCs');
    if (!rpcContainer) return;
    rpcContainer.textContent = '';
    if (!data.rpc || data.rpc.length === 0) {
        rpcContainer.textContent = 'None available';
        return;
    }
    let shown = 0;
    for (const entry of data.rpc) {
        if (shown >= 5) break;
        const url = typeof entry === 'string' ? entry : entry?.url;
        if (!url || url.includes('${')) continue;
        const a = document.createElement('a');
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = url.replace(/^https?:\/\//, '');
        rpcContainer.appendChild(a);
        shown++;
    }
    if (shown === 0) rpcContainer.textContent = 'None available';
}

function showExplorers(data) {
    const expContainer = document.getElementById('chainExplorers');
    if (!expContainer) return;
    expContainer.textContent = '';
    if (data.explorers && data.explorers.length > 0) {
        for (const e of data.explorers) {
            const a = document.createElement('a');
            a.href = e.url;
            a.target = "_blank";
            a.rel = "noopener";
            a.textContent = e.name;
            expContainer.appendChild(a);
        }
    } else {
        expContainer.textContent = 'None available';
    }
}

function getStatusClass(status) {
    if (!status) return '';
    const s = status.toLowerCase();
    if (s === 'active') return 'status-active';
    if (s === 'deprecated') return 'status-deprecated';
    if (s === 'incubating') return 'status-incubating';
    return '';
}

function showNodeDetails(node) {
    const panel = document.getElementById('detailsPanel');
    if (!panel) return;
    const data = node.data;

    const iconElem = document.getElementById('chainIcon');
    if (iconElem) {
        iconElem.textContent = node.name ? node.name.charAt(0).toUpperCase() : '?';
        iconElem.style.background = `linear-gradient(135deg, ${node.color}, ${node.color}33)`;
    }

    const nameElem = document.getElementById('chainName');
    if (nameElem) nameElem.textContent = node.name || 'Unknown Chain';
    const idBadge = document.getElementById('chainIdBadge');
    if (idBadge) idBadge.textContent = `ID: ${data.chainId}`;

    // Status badge
    const statusBadge = document.getElementById('chainStatusBadge');
    if (statusBadge) {
        if (data.status) {
            statusBadge.textContent = data.status.charAt(0).toUpperCase() + data.status.slice(1);
            statusBadge.className = `badge tag-badge ${getStatusClass(data.status)}`;
            statusBadge.style.display = 'inline-block';
        } else {
            statusBadge.style.display = 'none';
        }
    }

    showTagsBadge(data);

    const curElem = document.getElementById('chainCurrency');
    if (curElem) {
        curElem.textContent = data.nativeCurrency
            ? `${data.nativeCurrency.name} (${data.nativeCurrency.symbol})`
            : 'None';
    }

    const { row: rowL1, elem: l1Elem } = showParentRow('rowL1Parent', 'chainL1Parent', node.l2Parent);
    showParentRow('rowMainnet', 'chainMainnet', node.mainnetParent);

    if (!node.l2Parent && !node.mainnetParent && rowL1 && l1Elem) {
        rowL1.style.display = 'flex';
        l1Elem.textContent = 'None';
    }

    showChildrenSection('chainL2Children', 'labelL2Children', node.l2Children, 'L2 / L3');

    const rowTestnetChildren = document.getElementById('rowTestnetChildren');
    if (rowTestnetChildren) {
        if (node.data.tags?.includes('Testnet')) {
            rowTestnetChildren.style.display = 'none';
        } else {
            rowTestnetChildren.style.display = 'flex';
            showChildrenSection('chainTestnetChildren', 'labelTestnetChildren', node.testnetChildren, 'Testnets');
        }
    }

    showRpcEndpoints(data);
    showExplorers(data);
    showWebsite(data);

    panel.classList.remove('hidden');
}

function showTagsBadge(data) {
    const tagsElem = document.getElementById('chainTags');
    if (tagsElem) {
        if (data.tags?.length > 0) {
            tagsElem.textContent = data.tags.join(', ');
            tagsElem.style.display = 'inline-block';
        } else {
            tagsElem.style.display = 'none';
        }
    }
}

function showWebsite(data) {
    const webElem = document.getElementById('chainWebsite');
    if (!webElem) return;
    if (!data.infoURL) {
        webElem.textContent = 'None available';
        return;
    }
    try {
        const url = new URL(data.infoURL);
        const protocol = url.protocol.toLowerCase();

        if (protocol === 'http:' || protocol === 'https:') {
            const a = document.createElement('a');
            a.href = url.toString();
            a.target = "_blank";
            a.rel = "noopener";
            a.textContent = url.hostname;
            webElem.textContent = '';
            webElem.appendChild(a);
        } else {
            // Unsafe or unsupported protocol: show as plain text without a link
            webElem.textContent = data.infoURL;
        }
    } catch {
        // Invalid URL: show as plain text without a link
        webElem.textContent = data.infoURL;
    }
}
