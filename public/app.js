// Constants for Node Colors
const COLORS = {
    MAINNET: '#10b981', // Emerald green
    L2: '#8b5cf6',      // Purple
    TESTNET: '#f59e0b', // Amber
    BEACON: '#ec4899',  // Pink
    DEFAULT: '#6b7280'  // Gray
};

// Global State
let graphData = { nodes: [], links: [] };
let filteredData = { nodes: [], links: [] };
let currentFilter = 'all';
let myGraph = null;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    initUI();
    fetchData();
});

function initUI() {
    // Filter Buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');

            currentFilter = e.target.dataset.filter;
            applyFilters();
        });
    });

    // Search Logic (Custom Dropdown)
    const searchInput = document.getElementById('searchInput');
    const searchDropdown = document.getElementById('searchDropdown');

    window.searchAndFocus = (query) => {
        const q = String(query).toLowerCase().trim();
        if (!q) return;

        const node = graphData.nodes.find(n =>
            n.id.toString() === q ||
            n.name.toLowerCase() === q ||
            (n.data.shortName && n.data.shortName.toLowerCase() === q) ||
            (n.data.chain && n.data.chain.toLowerCase() === q) ||
            n.name.toLowerCase().includes(q)
        );

        if (node) {
            searchInput.value = node.name;
            searchDropdown.classList.add('hidden');
            focusNode(node);
        } else {
            alert('Chain not found. Try a different ID or name.');
        }
    };

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-box')) {
            searchDropdown.classList.add('hidden');
        }
    });

    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();

        if (!query) {
            searchDropdown.classList.add('hidden');
            return;
        }

        // Filter nodes matching search query
        const matches = graphData.nodes.filter(n =>
            n.name.toLowerCase().includes(query) ||
            n.id.toString().includes(query) ||
            (n.data.shortName && n.data.shortName.toLowerCase().includes(query)) ||
            (n.data.chain && n.data.chain.toLowerCase().includes(query)) ||
            (n.data.tags && n.data.tags.some(t => t.toLowerCase().includes(query)))
        );

        // Sort matches to prioritize exact/closer matches
        matches.sort((a, b) => {
            const aName = a.name.toLowerCase();
            const bName = b.name.toLowerCase();

            // Prioritize if the name starts with the query
            const aStarts = aName.startsWith(query);
            const bStarts = bName.startsWith(query);
            if (aStarts && !bStarts) return -1;
            if (!aStarts && bStarts) return 1;

            // Prioritize if the query is in the name vs tags
            const aInName = aName.includes(query);
            const bInName = bName.includes(query);
            if (aInName && !bInName) return -1;
            if (!aInName && bInName) return 1;

            // Fallback to alphabetical sort
            return aName.localeCompare(bName);
        });

        const topMatches = matches.slice(0, 100); // Limit to 100 results for scrollable container

        searchDropdown.innerHTML = '';

        if (topMatches.length === 0) {
            searchDropdown.innerHTML = '<div class="dropdown-empty">No chains found.</div>';
        } else {
            topMatches.forEach(node => {
                const item = document.createElement('div');
                item.className = 'dropdown-item';

                const iconColor = node.color;
                const initial = node.name ? node.name.charAt(0).toUpperCase() : '?';

                // Bold the matching part of the name
                const regex = new RegExp(`(${query})`, 'gi');
                const highlightedName = node.name.replace(regex, '<strong>$1</strong>');

                // Format tags
                const tagsList = (node.data.tags && node.data.tags.length > 0)
                    ? node.data.tags.join(', ') : node.type;

                item.innerHTML = `
                    <div class="dropdown-icon" style="background: linear-gradient(135deg, ${iconColor}, #050505);">${initial}</div>
                    <div class="dropdown-info">
                        <span class="dropdown-name">${highlightedName}</span>
                        <div class="dropdown-meta">
                            <span>ID: ${node.id}</span>
                            <span>•</span>
                            <span>${tagsList}</span>
                        </div>
                    </div>
                `;

                item.addEventListener('click', () => searchAndFocus(node.id));
                searchDropdown.appendChild(item);
            });
        }

        searchDropdown.classList.remove('hidden');
    });

    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') searchAndFocus(searchInput.value);
    });

    // Close Details Panel
    document.getElementById('closeDetails').addEventListener('click', () => {
        document.getElementById('detailsPanel').classList.add('hidden');
    });
}

async function fetchData() {
    try {
        const res = await fetch('./export.json');
        const exportData = await res.json();

        const chains = exportData.data.indexed.all;

        // Build relations map { parentId: { childId: { kind } } } from per-chain relations arrays
        const relations = {};
        chains.forEach(chain => {
            if (!chain.relations) return;
            chain.relations.forEach(rel => {
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
            });
        });

        processGraphData(chains, relations);

        // Hide loading overlay
        document.getElementById('loadingOverlay').classList.add('hidden');

        // Render
        renderGraph();
    } catch (error) {
        console.error('Error fetching data:', error);
        const overlay = document.getElementById('loadingOverlay');
        overlay.textContent = 'Failed to load data. Ensure export.json is available.';
        overlay.style.color = '#ef4444';
    }
}

function processGraphData(chains, relations) {
    const nodes = [];
    const links = [];

    // Create quick lookup maps
    const nodeMap = new Map();

    // First pass: Add all nodes
    chains.forEach(c => {
        // Determine node type/color based on tags
        let type = 'Mainnet';
        let color = COLORS.MAINNET;
        let val = 2; // Default size

        if (c.tags && c.tags.includes('Beacon')) {
            type = 'Beacon';
            color = COLORS.BEACON;
            val = 1.5;
        } else if (c.tags && c.tags.includes('L2')) {
            type = 'L2';
            color = COLORS.L2;
            val = 1.8;
        } else if (c.tags && c.tags.includes('Testnet')) {
            type = 'Testnet';
            color = COLORS.TESTNET;
            val = 1;
        } else {
            // Mainnets are larger
            val = 3;
            // E.g. Ethereum is huge
            if (c.chainId === 1) val = 8;
        }

        let displayName = c.name || `Chain ${c.chainId}`;
        if (c.tags && c.tags.includes('Testnet') && !displayName.toLowerCase().includes('testnet')) {
            displayName += ' Testnet';
        }

        const node = {
            id: c.chainId,
            name: displayName,
            val: val,
            color: color,
            type: type,
            data: c,
            parent: null, // used for filtering mostly
            l2Parent: null,
            mainnetParent: null,
            children: [],
            l2Children: [],
            testnetChildren: []
        };
        nodes.push(node);
        nodeMap.set(c.chainId, node);
    });



    // Second pass: Use relations API maps format { "parentID": { "childID": { ... } } }
    Object.keys(relations).forEach(parentIdStr => {
        const parentId = parseInt(parentIdStr);
        const childrenObj = relations[parentIdStr];

        Object.keys(childrenObj).forEach(childIdStr => {
            const childId = parseInt(childIdStr);
            const relationInfo = childrenObj[childIdStr]; // e.g. { kind: "l2Of", ... }

            const parentNode = nodeMap.get(parentId);
            const childNode = nodeMap.get(childId);

            if (parentNode && childNode) {
                links.push({
                    source: childId,
                    target: parentId,
                    kind: relationInfo.kind // 'l2Of', 'testnetOf', etc.
                });

                if (relationInfo.kind === 'l2Of' || relationInfo.kind === 'l1Of') {
                    childNode.l2Parent = parentNode;
                    parentNode.l2Children.push(childNode);
                } else if (relationInfo.kind === 'testnetOf' || relationInfo.kind === 'mainnetOf') {
                    childNode.mainnetParent = parentNode;
                    parentNode.testnetChildren.push(childNode);
                }

                childNode.parent = parentNode; // fallback 
                parentNode.children.push(childNode); // fallback
            }
        });
    });

    graphData = { nodes, links };
    filteredData = { nodes: [...nodes], links: [...links] };
}

function applyFilters() {
    if (currentFilter === 'all') {
        filteredData = {
            nodes: [...graphData.nodes],
            links: [...graphData.links]
        };
    } else if (currentFilter === 'Mainnet') {
        const visibleNodesSet = new Set();

        // Recursively add L2 children (handles L3, L4, etc.)
        // Skip testnet chains — only mainnet (production) chains belong here
        function addL2Tree(node) {
            if (node.l2Children) {
                node.l2Children.forEach(child => {
                    const isTestnet = child.data.tags && child.data.tags.includes('Testnet');
                    if (!visibleNodesSet.has(child) && !isTestnet) {
                        visibleNodesSet.add(child);
                        addL2Tree(child);
                    }
                });
            }
        }

        // Add all Mainnet and Beacon nodes (Beacon chains like Ethereum are also mainnets)
        // and recursively add their entire L2 tree.
        // Exclude nodes that are testnets (have a mainnetParent) even if they lack the Testnet tag.
        graphData.nodes.forEach(n => {
            if ((n.type === 'Mainnet' || n.type === 'Beacon') && !n.mainnetParent) {
                visibleNodesSet.add(n);
                addL2Tree(n);
            }
        });

        const visibleNodes = Array.from(visibleNodesSet);
        const visibleNodeIds = new Set(visibleNodes.map(n => n.id));

        // Include all non-testnet links between visible nodes
        const visibleLinks = graphData.links.filter(l => {
            const sourceId = l.source.id || l.source;
            const targetId = l.target.id || l.target;
            return visibleNodeIds.has(sourceId) && visibleNodeIds.has(targetId) && l.kind !== 'testnetOf';
        });

        filteredData = {
            nodes: visibleNodes,
            links: visibleLinks
        };
    } else {
        const visibleNodesSet = new Set();

        // Add nodes matching filter AND their parents
        graphData.nodes.forEach(n => {
            if (n.type === currentFilter) {
                visibleNodesSet.add(n);
                if (n.parent) {
                    visibleNodesSet.add(n.parent);
                }
            }
        });

        const visibleNodes = Array.from(visibleNodesSet);
        const visibleNodeIds = new Set(visibleNodes.map(n => n.id));

        const visibleLinks = graphData.links.filter(l =>
            visibleNodeIds.has(l.source.id || l.source) &&
            visibleNodeIds.has(l.target.id || l.target)
        );

        filteredData = {
            nodes: visibleNodes,
            links: visibleLinks
        };
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
        .nodeResolution(16) // Higher res spheres
        .linkColor(link => {
            if (link.kind === 'l2Of' || link.kind === 'l1Of') return 'rgba(139, 92, 246, 0.45)'; // Purple for L2
            if (link.kind === 'testnetOf') return 'rgba(245, 158, 11, 0.45)'; // Amber for Testnet
            return 'rgba(255, 255, 255, 0.15)'; // Default
        })
        .linkWidth(1)
        .linkDirectionalParticles(link => {
            // Adds small moving particles to highlight relation direction (child -> parent)
            if (link.kind === 'l2Of' || link.kind === 'l1Of' || link.kind === 'testnetOf') return 2;
            return 0;
        })
        .linkDirectionalParticleSpeed(0.005)
        .linkDirectionalParticleColor(link => {
            if (link.kind === 'l2Of' || link.kind === 'l1Of') return 'rgba(139, 92, 246, 0.8)';
            if (link.kind === 'testnetOf') return 'rgba(245, 158, 11, 0.8)';
            return '#ffffff';
        })
        .backgroundColor('#050505')
        .cooldownTicks(100) // Stop physics engine early to prevent lag
        .onNodeClick(node => focusNode(node));
}

function focusNode(node) {
    if (!myGraph) return;

    // Aim at node from outside it
    const distance = 150;
    const distRatio = 1 + distance / Math.hypot(node.x, node.y, node.z);

    const newPos = node.x || node.y || node.z
        ? { x: node.x * distRatio, y: node.y * distRatio, z: node.z * distRatio }
        : { x: 0, y: 0, z: distance }; // special case if node is at (0,0,0)

    myGraph.cameraPosition(
        newPos,
        node, // lookAt
        1500  // ms transition
    );

    showNodeDetails(node);
}

function showNodeDetails(node) {
    const panel = document.getElementById('detailsPanel');
    const data = node.data;

    // Set Icon char
    const iconElem = document.getElementById('chainIcon');
    iconElem.textContent = node.name ? node.name.charAt(0).toUpperCase() : '?';
    iconElem.style.background = `linear-gradient(135deg, ${node.color}, #000)`;

    document.getElementById('chainName').textContent = node.name || 'Unknown Chain';
    document.getElementById('chainIdBadge').textContent = `ID: ${data.chainId}`;

    // Tags
    const tagsElem = document.getElementById('chainTags');
    if (data.tags && data.tags.length > 0) {
        tagsElem.textContent = `Tags: ${data.tags.join(', ')}`;
        tagsElem.style.display = 'inline-block';
    } else {
        tagsElem.style.display = 'none';
    }

    // Currency
    const curElem = document.getElementById('chainCurrency');
    if (data.nativeCurrency) {
        curElem.textContent = `${data.nativeCurrency.name} (${data.nativeCurrency.symbol})`;
    } else {
        curElem.textContent = 'None';
    }

    // Status
    document.getElementById('chainStatus').textContent = data.status ?
        data.status.charAt(0).toUpperCase() + data.status.slice(1) : 'Unknown';

    // L1/Parent
    const rowL1 = document.getElementById('rowL1Parent');
    const l1Elem = document.getElementById('chainL1Parent');
    if (node.l2Parent) {
        rowL1.style.display = 'flex';
        l1Elem.innerHTML = `<a href="#" onclick="searchAndFocus('${node.l2Parent.id}')">${node.l2Parent.name}</a>`;
    } else {
        rowL1.style.display = 'none';
        l1Elem.textContent = '--';
    }

    // Mainnet
    const rowMainnet = document.getElementById('rowMainnet');
    const mainnetElem = document.getElementById('chainMainnet');
    if (node.mainnetParent) {
        rowMainnet.style.display = 'flex';
        mainnetElem.innerHTML = `<a href="#" onclick="searchAndFocus('${node.mainnetParent.id}')">${node.mainnetParent.name}</a>`;
    } else {
        rowMainnet.style.display = 'none';
        mainnetElem.textContent = '--';
    }

    // If both are missing, just show L1 as "None"
    if (!node.l2Parent && !node.mainnetParent) {
        rowL1.style.display = 'flex';
        l1Elem.textContent = 'None';
    }

    // L2 / L3 Children
    const l2Container = document.getElementById('chainL2Children');
    const labelL2Children = document.getElementById('labelL2Children');
    l2Container.innerHTML = '';
    if (node.l2Children && node.l2Children.length > 0) {
        labelL2Children.textContent = `L2 / L3 (${node.l2Children.length})`;
        node.l2Children.forEach(child => {
            const a = document.createElement('a');
            a.href = "#";
            a.textContent = child.name;
            a.onclick = (e) => { e.preventDefault(); searchAndFocus(child.id); };
            l2Container.appendChild(a);
        });
    } else {
        labelL2Children.textContent = 'L2 / L3';
        l2Container.textContent = 'None';
    }

    // Testnets (Children)
    const rowTestnetChildren = document.getElementById('rowTestnetChildren');
    const labelTestnetChildren = document.getElementById('labelTestnetChildren');
    if (node.data.tags && node.data.tags.includes('Testnet')) {
        rowTestnetChildren.style.display = 'none';
    } else {
        rowTestnetChildren.style.display = 'flex';
        const testnetContainer = document.getElementById('chainTestnetChildren');
        testnetContainer.innerHTML = '';
        if (node.testnetChildren && node.testnetChildren.length > 0) {
            labelTestnetChildren.textContent = `Testnets (${node.testnetChildren.length})`;
            node.testnetChildren.forEach(child => {
                const a = document.createElement('a');
                a.href = "#";
                a.textContent = child.name;
                a.onclick = (e) => { e.preventDefault(); searchAndFocus(child.id); };
                testnetContainer.appendChild(a);
            });
        } else {
            labelTestnetChildren.textContent = 'Testnets';
            testnetContainer.textContent = 'None';
        }
    }

    // RPCs
    const rpcContainer = document.getElementById('chainRPCs');
    rpcContainer.innerHTML = '';
    if (data.rpc && data.rpc.length > 0) {
        let shown = 0;
        for (const entry of data.rpc) {
            if (shown >= 5) break; // Show up to 5 RPCs
            const url = typeof entry === 'string' ? entry : entry?.url;
            if (!url || url.includes('${')) continue; // filter out template strings and missing urls
            const a = document.createElement('a');
            a.href = url;
            a.target = "_blank";
            a.textContent = url.replace('https://', '');
            rpcContainer.appendChild(a);
            shown++;
        }
        if (shown === 0) rpcContainer.textContent = 'None available';
    } else {
        rpcContainer.textContent = 'None available';
    }

    // Explorers
    const expContainer = document.getElementById('chainExplorers');
    expContainer.innerHTML = '';
    if (data.explorers && data.explorers.length > 0) {
        data.explorers.forEach(e => {
            const a = document.createElement('a');
            a.href = e.url;
            a.target = "_blank";
            a.textContent = e.name;
            expContainer.appendChild(a);
        });
    } else {
        expContainer.textContent = 'None available';
    }

    // Website
    const webElem = document.getElementById('chainWebsite');
    if (data.infoURL) {
        webElem.innerHTML = `<a href="${data.infoURL}" target="_blank">${new URL(data.infoURL).hostname}</a>`;
    } else {
        webElem.textContent = 'None available';
    }

    panel.classList.remove('hidden');
}
