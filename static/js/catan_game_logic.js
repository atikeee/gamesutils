const canvas = document.getElementById('catanBoard');
const ctx = canvas.getContext('2d');
const messageBox = document.getElementById('messageBox');

const isGamePage = window.location.pathname === '/catan_game';
const isPlayerPage = window.location.pathname.startsWith('/catan_player/');

const PLAYER_ID_RAW = isPlayerPage ? window.location.pathname.split('/').pop() : null;
const PLAYER_ID = isPlayerPage ? 'player' + PLAYER_ID_RAW : null;


let loadedResourceImages = {};
let boardTiles = [];
let selectedHandCards  = [];
const socket = io();
let init_player_data = {
    'player1': { playerName: 'Player 1', hand: ["wood", "brick", "sheep", "wheat", "wood", "brick", "wood", "brick", "wood", "brick", "sheep", "wheat"], devCards: [], roads: [], structures: [], history: [] },
    'player2': { playerName: 'Player 2', hand: ["wood", "brick", "sheep", "wheat", "wood", "brick", "wood", "brick", "wood", "brick", "sheep", "wheat"], devCards: [], roads: [], structures: [], history: [] },
    'player3': { playerName: 'Player 3', hand: ["wood", "brick", "sheep", "wheat", "wood", "brick", "wood", "brick", "wood", "brick", "sheep", "wheat"], devCards: [], roads: [], structures: [], history: [] },
    'player4': { playerName: 'Player 4', hand: ["wood", "brick", "sheep", "wheat", "wood", "brick", "wood", "brick", "wood", "brick", "sheep", "wheat"], devCards: [], roads: [], structures: [], history: [] },
    'robber':{q:100,r:100}
}; 
let allPlayersData = init_player_data;
const CARD_COSTS = {
    'road': { 'wood': 1, 'brick': 1 },
    'house': { 'wood': 1, 'brick': 1, 'sheep': 1, 'wheat': 1 },
    'city': { 'ore': 3, 'wheat': 2 },
    'dev': { 'ore': 1, 'sheep': 1, 'wheat': 1 }
};
let globalDevCardDeck = [];

let offsetX = 0;
let offsetY = 0;

let boardCenterRawX = 0;
let boardCenterRawY = 0;

let selectedTool = 'swap';
let selectedSwapItem1 = null;
let selectedSwapItem2 = null;
let builderHistoryStack = [];

let selectedPlayerTool = null;
let selectedRoadStartJunction = null;

let allJunctions = [];
let allEdges = [];

const confirmationModal = document.getElementById('confirmationModal');
const modalMessage = document.getElementById('modalMessage');
const modalConfirmBtn = document.getElementById('modalConfirmBtn');
const modalCancelBtn = document.getElementById('modalCancelBtn');
let modalResolve;

function showMessage(message, type = 'info') {
    messageBox.textContent = message;
    messageBox.className = `message-box ${type === 'error' ? 'bg-red-100 text-red-800 border-red-300' : 'bg-yellow-100 text-yellow-800 border-yellow-300'}`;
    messageBox.classList.remove('hidden');
    setTimeout(() => {
        messageBox.classList.add('hidden');
    }, 3000);
}

function showConfirmation(message) {
    modalMessage.textContent = message;
    confirmationModal.classList.remove('hidden');
    return new Promise(resolve => {
        modalResolve = resolve;
    });
}

function hideConfirmation() {
    confirmationModal.classList.add('hidden');
}

if (modalConfirmBtn && modalCancelBtn) {
    modalConfirmBtn.addEventListener('click', () => {
        hideConfirmation();
        if (modalResolve) modalResolve(true);
    });

    modalCancelBtn.addEventListener('click', () => {
        hideConfirmation();
        if (modalResolve) modalResolve(false);
    });
}

function preloadImages() {
    let imagesToLoad = Object.keys(resourceImagePaths).length;
    if (imagesToLoad === 0) {
        loadAllStatesFromBackend();
        return;
    }

    for (const type in resourceImagePaths) {
        const img = new Image();
        img.src = resourceImagePaths[type];
        img.onload = () => {
            loadedResourceImages[type] = img;
            imagesToLoad--;
            if (imagesToLoad === 0) {
                loadAllStatesFromBackend();
            }
        };
        img.onerror = () => {
            console.error(`Failed to load image for ${type}: ${resourceImagePaths[type]}`);
            loadedResourceImages[type] = null;
            imagesToLoad--;
            if (imagesToLoad === 0) {
                loadAllStatesFromBackend();
            }
        };
    }
}

function drawBoard() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    boardTiles.forEach(tile => {
        const pixel = hexToPixel(tile.q, tile.r, offsetX, offsetY);
        const image = loadedResourceImages[tile.type];
        drawHex(ctx, pixel.x, pixel.y, TILE_RADIUS, RESOURCE_COLORS[tile.type], image);
        if (tile.number !== null) {
            drawNumber(ctx, pixel.x, pixel.y, tile.number);
        }
    });

    for (const playerId in allPlayersData) {
        if (playerId.startsWith('player')){
            const playerData = allPlayersData[playerId];
            if (playerData && playerData.roads && playerData.structures) {
                playerData.roads.forEach(road => {
                    drawRoad(ctx, road.edge, PLAYER_COLORS[road.owner], offsetX, offsetY);
                });
                playerData.structures.forEach(structure => {
                    const ownerColor = PLAYER_COLORS[structure.owner];
                    if (structure.type === 'house') {
                        drawHouse(ctx, structure.junction, ownerColor, offsetX, offsetY);
                    } else if (structure.type === 'city') {
                        drawCity(ctx, structure.junction, ownerColor, offsetX, offsetY);
                    }
                });
            }
        }
    }

    if (allPlayersData['robber'].q!=100 & allPlayersData['robber'].r!=100) {
        drawRobber(ctx, allPlayersData['robber'], offsetX, offsetY);
    }

    if (allJunctions.length === 0 && boardTiles.length > 0) {
        allJunctions = getAllJunctions();
    }

    const perimeterJunctions = allJunctions.filter(junction => countTilesForJunction(junction, boardTiles) < 3);

    perimeterJunctions.forEach((junction, index) => {
        const portInfo = PORT_DATA[index];

        if (portInfo && portInfo.length === 2) {
            const [type, ratio] = portInfo;

            const junctionX = junction.x + offsetX;
            const junctionY = junction.y + offsetY;

            const vecX = junctionX - (boardCenterRawX + offsetX);
            const vecY = junctionY - (boardCenterRawY + offsetY);
            const vecMagnitude = Math.sqrt(vecX * vecX + vecY * vecY);

            const offsetDistance = HEX_SIZE * 0.4;
            const portDrawX = junctionX + (vecX / vecMagnitude) * offsetDistance;
            const portDrawY = junctionY + (vecY / vecMagnitude) * offsetDistance;

            drawCirclePort(ctx, portDrawX, portDrawY, type, ratio, null);
        }
    });

    if (!isGamePage && !isPlayerPage) {
        if (selectedTool === 'swap') {
            if (selectedSwapItem1) {
                const pixel = hexToPixel(selectedSwapItem1.tile.q, selectedSwapItem1.tile.r, offsetX, offsetY);
                ctx.strokeStyle = 'cyan';
                ctx.lineWidth = 4;

                if (selectedSwapItem1.type === 'tile') {
                    ctx.beginPath();
                    const vertices = getHexVertices(pixel.x, pixel.y, TILE_RADIUS);
                    ctx.moveTo(vertices[0].x, vertices[0].y);
                    for (let i = 1; i < 6; i++) {
                        ctx.lineTo(vertices[i].x, vertices[i].y);
                    }
                    ctx.closePath();
                    ctx.stroke();
                } else if (selectedSwapItem1.type === 'number') {
                    ctx.beginPath();
                    ctx.arc(pixel.x, pixel.y, NUMBER_RADIUS + 2, 0, Math.PI * 2);
                    ctx.stroke();
                }
            }
            if (selectedSwapItem2) {
                const pixel = hexToPixel(selectedSwapItem2.tile.q, selectedSwapItem2.tile.r, offsetX, offsetY);
                ctx.strokeStyle = 'magenta';
                ctx.lineWidth = 4;

                if (selectedSwapItem2.type === 'tile') {
                    ctx.beginPath();
                    const vertices = getHexVertices(pixel.x, pixel.y, TILE_RADIUS);
                    ctx.moveTo(vertices[0].x, vertices[0].y);
                    for (let i = 1; i < 6; i++) {
                        ctx.lineTo(vertices[i].x, vertices[i].y);
                    }
                    ctx.closePath();
                    ctx.stroke();
                } else if (selectedSwapItem2.type === 'number') {
                    ctx.beginPath();
                    ctx.arc(pixel.x, pixel.y, NUMBER_RADIUS + 2, 0, Math.PI * 2);
                    ctx.stroke();
                }
            }
        }
    }
}

function saveBuilderState() {
    if (isGamePage || isPlayerPage) return;

    builderHistoryStack.push({
        tileStates: JSON.parse(JSON.stringify(boardTiles.map(tile => ({ q: tile.q, r: tile.r, type: tile.type, number: tile.number })))),
        robber: allPlayersData['robber'] ? JSON.parse(JSON.stringify(allPlayersData['robber'])) : null,
    });
}

function undoBuilderLastAction() {
    if (isGamePage || isPlayerPage) return;

    if (builderHistoryStack.length > 1) {
        builderHistoryStack.pop();
        const prevState = builderHistoryStack[builderHistoryStack.length - 1];

        prevState.tileStates.forEach(prevTile => {
            const currentTile = boardTiles.find(t => t.q === prevTile.q && t.r === prevTile.r);
            if (currentTile) {
                currentTile.type = prevTile.type;
                currentTile.number = prevTile.number;
            }
        });
        allPlayersData['robber'] = prevState.robber ? JSON.parse(JSON.stringify(prevState.robber)) : null;

        selectedSwapItem1 = null;
        selectedSwapItem2 = null;

        showMessage('Last action undone.');
        drawBoard();
    } else {
        showMessage('No more actions to undo.', 'error');
    }
}

function savePlayerStateToHistory() {
    if (!isPlayerPage || !allPlayersData[PLAYER_ID]) return;

    allPlayersData[PLAYER_ID].history.push({
        roads: JSON.parse(JSON.stringify(allPlayersData[PLAYER_ID].roads)),
        structures: JSON.parse(JSON.stringify(allPlayersData[PLAYER_ID].structures)),
        hand: JSON.parse(JSON.stringify(allPlayersData[PLAYER_ID].hand)),
        devCards: JSON.parse(JSON.stringify(allPlayersData[PLAYER_ID].devCards)),
        robber: allPlayersData['robber'] ? JSON.parse(JSON.stringify(allPlayersData['robber'])) : null
    });
    console.log(`Client: Saved player state to history. History length: ${allPlayersData[PLAYER_ID].history.length}`);
}

function undoPlayerLastAction() {
    if (!isPlayerPage || !allPlayersData[PLAYER_ID]) return;

    if (allPlayersData[PLAYER_ID].history.length > 1) {
        allPlayersData[PLAYER_ID].history.pop();
        const prevState = allPlayersData[PLAYER_ID].history[allPlayersData[PLAYER_ID].history.length - 1];

        allPlayersData[PLAYER_ID].roads = JSON.parse(JSON.stringify(prevState.roads));
        allPlayersData[PLAYER_ID].structures = JSON.parse(JSON.stringify(prevState.structures));
        allPlayersData[PLAYER_ID].hand = JSON.parse(JSON.stringify(prevState.hand));
        allPlayersData[PLAYER_ID].devCards = JSON.parse(JSON.stringify(prevState.devCards));
        allPlayersData['robber'] = prevState.robber ? JSON.parse(JSON.stringify(prevState.robber)) : null;
        showMessage('Your last action undone.');
        // Removed socket.emit for undo action
        drawBoard();
        updatePlayerUI();
    } else {
        showMessage('No more actions to undo for this player.', 'error');
    }
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

function shuffleCells() {
    if (isGamePage || isPlayerPage) return;

    saveBuilderState();

    const nonDesertTiles = boardTiles.filter(tile => tile.type !== 'desert');
    const resourceTypes = nonDesertTiles.map(tile => tile.type);
    shuffleArray(resourceTypes);

    nonDesertTiles.forEach((tile, index) => {
        tile.type = resourceTypes[index];
    });

    showMessage('Cells shuffled!');
    drawBoard();
}

function shuffleNumbers() {
    if (isGamePage || isPlayerPage) return;

    saveBuilderState();

    const nonDesertTiles = boardTiles.filter(tile => tile.type !== 'desert');
    const numbers = nonDesertTiles.map(tile => tile.number);
    shuffleArray(numbers);

    nonDesertTiles.forEach((tile, index) => {
        tile.number = numbers[index];
    });

    showMessage('Numbers shuffled!');
    drawBoard();
}

async function saveBoardTilesToBackend() {
    if (isGamePage || isPlayerPage) return;

    try {
        const boardTilesState = {
            boardTiles: boardTiles.map(tile => ({
                q: tile.q,
                r: tile.r,
                type: tile.type,
                number: tile.number
            })),
        };
        const response = await fetch('/save_board', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(boardTilesState),
        });
        const result = await response.json();
        if (result.status === 'success') {
            showMessage(result.message);
        } else {
            showMessage('Error saving board tiles: ' + result.message, 'error');
        }
    } catch (e) {
        showMessage('Network error saving board tiles: ' + e.message, 'error');
        console.error('Error saving board tiles to backend:', e);
    }
}

async function loadBoardTilesFromBackend() {
    try {
        const response = await fetch('/load_board');
        const result = await response.json();
        if (result.status === 'success' && result.board_state) {
            boardTiles = result.board_state.boardTiles;
            if (!isGamePage && !isPlayerPage) {
                saveBuilderState();
            }
            showMessage('Board tiles loaded successfully!');
        } else {
            showMessage((result.message || "No saved board tiles found.") + ' Displaying default board tiles.', 'info');
            boardTiles = [
                { q: 0, r: -2, type: 'ore', number: 10 },
                { q: 1, r: -2, type: 'sheep', number: 2 },
                { q: 2, r: -2, type: 'wood', number: 9 },
                { q: -1, r: -1, type: 'brick', number: 12 },
                { q: 0, r: -1, type: 'wheat', number: 6 },
                { q: 1, r: -1, type: 'ore', number: 4 },
                { q: 2, r: -1, type: 'wood', number: 10 },
                { q: -2, r: 0, type: 'wood', number: 9 },
                { q: -1, r: 0, type: 'sheep', number: 11 },
                { q: 0, r: 0, type: 'desert', number: null },
                { q: 1, r: 0, type: 'brick', number: 3 },
                { q: 2, r: 0, type: 'wheat', number: 8 },
                { q: -2, r: 1, type: 'ore', number: 8 },
                { q: -1, r: 1, type: 'wheat', number: 3 },
                { q: 0, r: 1, type: 'wood', number: 4 },
                { q: 1, r: 1, type: 'sheep', number: 5 },
                { q: -2, r: 2, type: 'brick', number: 5 },
                { q: -1, r: 2, type: 'sheep', number: 6 },
                { q: 0, r: 2, type: 'wheat', number: 11 }
            ];
            if (!isGamePage && !isPlayerPage) {
                saveBuilderState();
            }
        }
        allJunctions = getAllJunctions();
        allEdges = getAllEdges();
        resizeCanvas();
    } catch (e) {
        showMessage('Network error loading board tiles: ' + e.message + '. Displaying default board tiles.', 'error');
        console.error('Error loading board tiles from backend:', e);
        boardTiles = [
            { q: 0, r: -2, type: 'ore', number: 10 },
            { q: 1, r: -2, type: 'sheep', number: 2 },
            { q: 2, r: -2, type: 'wood', number: 9 },
            { q: -1, r: -1, type: 'brick', number: 12 },
            { q: 0, r: -1, type: 'wheat', number: 6 },
            { q: 1, r: -1, type: 'ore', number: 4 },
            { q: 2, r: -1, type: 'wood', number: 10 },
            { q: -2, r: 0, type: 'wood', number: 9 },
            { q: -1, r: 0, type: 'sheep', number: 11 },
            { q: 0, r: 0, type: 'desert', number: null },
            { q: 1, r: 0, type: 'brick', number: 3 },
            { q: 2, r: 0, type: 'wheat', number: 8 },
            { q: -2, r: 1, type: 'ore', number: 8 },
            { q: -1, r: 1, type: 'wheat', number: 3 },
            { q: 0, r: 1, type: 'wood', number: 4 },
            { q: 1, r: 1, type: 'sheep', number: 5 },
            { q: -2, r: 2, type: 'brick', number: 5 },
            { q: -1, r: 2, type: 'sheep', number: 6 },
            { q: 0, r: 2, type: 'wheat', number: 11 }
        ];
        allJunctions = getAllJunctions();
        allEdges = getAllEdges();
        resizeCanvas();
    }
}

async function saveAllPlayerStatesToBackend() {
    if (isGamePage){
        
    }
    else{
        try {
            const response = await fetch('/save_play_state', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(allPlayersData),
            });
            const result = await response.json();
            if (result.status === 'success') {
                showMessage(result.message);

                
            } else {
                console.error('Error saving all player states:', result.message);
                showMessage('Error saving all player states: ' + result.message, 'error');
            }
        } catch (e) {
            console.error('Network error saving all player states:', e);
            showMessage('Network error saving all player states: ' + e.message, 'error');
        }
    }
    console.log('sending signal');
    socket.emit('catan_update');
    console.log('sent signal');

    
    
    
}

async function loadAllPlayerStatesFromBackend() {
    try {
        const response = await fetch('/load_play_state');
        
        const result = await response.json();
        if (result.status === 'success' && result.play_state) {
            const loadedStates = result.play_state;
            for (const pId in loadedStates) {
                if (allPlayersData[pId]) {
                    allPlayersData[pId].playerName = loadedStates[pId].playerName || `Player ${pId.replace('player', '')}`;
                    allPlayersData[pId].hand = loadedStates[pId].hand || [];
                    allPlayersData[pId].devCards = loadedStates[pId].devCards || [];
                    allPlayersData[pId].roads = loadedStates[pId].roads || [];
                    allPlayersData[pId].structures = loadedStates[pId].structures || [];
                    allPlayersData[pId].history = loadedStates[pId].history || [];
                }
            }
            allPlayersData['robber']=loadedStates['robber'] || {q:100,r:100};

            if (isPlayerPage && PLAYER_ID && allPlayersData[PLAYER_ID].history.length === 0) {
                savePlayerStateToHistory();
            }
            showMessage('All player states loaded successfully!');
        } else {
            showMessage("No saved player states found. Initializing default player states.", 'info');
            allPlayersData = init_player_data;
            if (isPlayerPage && PLAYER_ID) {
                savePlayerStateToHistory();
            }
        }
        drawBoard();
    } catch (e) {
        showMessage('Network error loading player states: ' + e.message + '. Initializing default player states.', 'error');
        console.error('Error loading player states from backend:', e);
        allPlayersData = init_player_data;
        if (isPlayerPage && PLAYER_ID) {
            savePlayerStateToHistory();
        }
        drawBoard();
    }
}
async function loadAllStatesFromBackend() {
    console.log("loading data");
    await loadBoardTilesFromBackend();
    await loadAllPlayerStatesFromBackend();
    //await loadRobberStateFromBackend();
    drawBoard();
}

function getAllJunctions() {
    const junctions = new Map();

    boardTiles.forEach(tile => {
        const rawPixel = hexToRawPixel(tile.q, tile.r);
        const vertices = getHexVertices(rawPixel.x, rawPixel.y, TILE_RADIUS);
        vertices.forEach(v => {
            const id = `${Math.round(v.x)},${Math.round(v.y)}`;
            if (!junctions.has(id)) {
                junctions.set(id, { x: v.x, y: v.y, id: id });
            }
        });
    });
    return Array.from(junctions.values());
}

function getAllEdges() {
    const edges = new Map();

    boardTiles.forEach(tile => {
        const rawPixel = hexToRawPixel(tile.q, tile.r);
        const vertices = getHexVertices(rawPixel.x, rawPixel.y, TILE_RADIUS);
        for (let i = 0; i < 6; i++) {
            const v1 = vertices[i];
            const v2 = vertices[(i + 1) % 6];
            const id1 = `${Math.round(v1.x)},${Math.round(v1.y)}`;
            const id2 = `${Math.round(v2.x)},${Math.round(v2.y)}`;
            const edgeId = [id1, id2].sort().join('-');

            if (!edges.has(edgeId)) {
                edges.set(edgeId, { x1: v1.x, y1: v1.y, x2: v2.x, y2: v2.y, id: edgeId });
            }
        }
    });
    return Array.from(edges.values());
}

function getClosestJunction(px, py, threshold = 20) {
    let closestJunction = null;
    let minDistance = Infinity;

    allJunctions.forEach(junction => {
        const junctionX = junction.x + offsetX;
        const junctionY = junction.y + offsetY;
        const dist = Math.sqrt(Math.pow(px - junctionX, 2) + Math.pow(py - junctionY, 2));
        if (dist < minDistance && dist < threshold) {
            minDistance = dist;
            closestJunction = junction;
        }
    });
    return closestJunction;
}

function getClosestEdge(px, py, threshold = 20) {
    let closestEdge = null;
    let minDistance = Infinity;

    allEdges.forEach(edge => {
        const edgeX1 = edge.x1 + offsetX;
        const edgeY1 = edge.y1 + offsetY;
        const edgeX2 = edge.x2 + offsetX;
        const edgeY2 = edge.y2 + offsetY;

        const A = px - edgeX1;
        const B = py - edgeY1;
        const C = edgeX2 - edgeX1;
        const D = edgeY2 - edgeY1;

        const dot = A * C + B * D;
        const len_sq = C * C + D * D;
        let param = -1;
        if (len_sq != 0) {
            param = dot / len_sq;
        }

        let xx, yy;
        if (param < 0) {
            xx = edgeX1;
            yy = edgeY1;
        } else if (param > 1) {
            xx = edgeX2;
            yy = edgeY2;
        } else {
            xx = edgeX1 + param * C;
            yy = edgeY1 + param * D;
        }

        const dx = px - xx;
        const dy = py - yy;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < minDistance && dist < threshold) {
            minDistance = dist;
            closestEdge = edge;
        }
    });
    return closestEdge;
}

canvas.addEventListener('click', (event) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mouseX = (event.clientX - rect.left) * scaleX;
    const mouseY = (event.clientY - rect.top) * scaleY;

    let actionSuccessful = false;

    if (!isGamePage && !isPlayerPage) {
        if (selectedTool === 'swap') {
            const clickedHex = pixelToHex(mouseX, mouseY, offsetX, offsetY);
            const clickedTile = boardTiles.find(t => t.q === clickedHex.q && t.r === clickedHex.r);

            if (clickedTile) {
                const isNumberClick = isPointInNumberCircle(mouseX, mouseY, clickedTile, offsetX, offsetY);
                const currentSelectionType = isNumberClick ? 'number' : 'tile';

                if (clickedTile.type === 'desert' && isNumberClick) {
                    showMessage('Cannot swap numbers on a desert tile.', 'error');
                } else if (!selectedSwapItem1) {
                    selectedSwapItem1 = { type: currentSelectionType, tile: clickedTile };
                    showMessage(`First ${currentSelectionType} selected. Click another ${currentSelectionType} to swap.`);
                } else if (selectedSwapItem1.tile.q === clickedTile.q && selectedSwapItem1.tile.r === clickedTile.r) {
                    showMessage(`${selectedSwapItem1.type} deselected. Start new selection.`, 'info');
                    selectedSwapItem1 = null;
                    selectedSwapItem2 = null;
                } else if (selectedSwapItem1.type !== currentSelectionType) {
                    showMessage(`Cannot swap a ${selectedSwapItem1.type} with a ${currentSelectionType}. Please select two of the same type.`, 'error');
                    selectedSwapItem1 = { type: currentSelectionType, tile: clickedTile };
                    selectedSwapItem2 = null;
                } else {
                    selectedSwapItem2 = { type: currentSelectionType, tile: clickedTile };

                    if (selectedSwapItem1.type === 'number') {
                        const tempNumber = selectedSwapItem1.tile.number;
                        selectedSwapItem1.tile.number = selectedSwapItem2.tile.number;
                        selectedSwapItem2.tile.number = tempNumber;
                        showMessage('Numbers swapped successfully!');
                    } else if (selectedSwapItem1.type === 'tile') {
                        const tempType = selectedSwapItem1.tile.type;
                        const tempNumber = selectedSwapItem1.tile.number;

                        selectedSwapItem1.tile.type = selectedSwapItem2.tile.type;
                        selectedSwapItem1.tile.number = selectedSwapItem2.tile.number;

                        selectedSwapItem2.tile.type = tempType;
                        selectedSwapItem2.tile.number = tempNumber;
                        showMessage('Tiles swapped successfully!');
                    }
                    actionSuccessful = true;
                    selectedSwapItem1 = null;
                    selectedSwapItem2 = null;
                }
            } else {
                showMessage('Click on a resource tile to select for swap.', 'error');
                selectedSwapItem1 = null;
                selectedSwapItem2 = null;
            }
        }
    } else if (isPlayerPage) {
        if (selectedPlayerTool === 'house') {
            
            const clickedJunction = getClosestJunction(mouseX, mouseY);
            if (clickedJunction) {
                let existingStructure = false;
                for (const pId in allPlayersData) {
                    if (pId.startsWith('player')){
                        if (allPlayersData[pId].structures.some(s => s.junction.id === clickedJunction.id)) {
                            existingStructure = true;
                            break;
                        }
                    }
                }

                if (existingStructure) {
                    showMessage('A structure already exists here.', 'error');
                } else {
                    //function to add items to the board
                    if(checkAndDeductCards(PLAYER_ID,selectedPlayerTool))
                    {
                        savePlayerStateToHistory();
                        allPlayersData[PLAYER_ID].structures.push({ type: selectedPlayerTool, junction: clickedJunction, owner: PLAYER_ID });
                        showMessage(`${selectedPlayerTool} placed!`);
                        updatePlayerUI();
                        actionSuccessful = true;
                    }
                }
            } else {
                showMessage('Click near a junction to place a house.', 'error');
            }
        } else if (selectedPlayerTool === 'city') {
            const clickedJunction = getClosestJunction(mouseX, mouseY);
            if (clickedJunction) {
                const existingHouse = allPlayersData[PLAYER_ID].structures.find(s => s.junction.id === clickedJunction.id && s.type === 'house' && s.owner === PLAYER_ID);
                if (existingHouse) {
                    if(checkAndDeductCards(PLAYER_ID,selectedPlayerTool))
                    {
                        savePlayerStateToHistory();
                        allPlayersData[PLAYER_ID].structures.push({ type: selectedPlayerTool, junction: clickedJunction, owner: PLAYER_ID });
                        showMessage(`${selectedPlayerTool} placed!`);
                        updatePlayerUI();
                        existingHouse.type = 'city';
                        actionSuccessful = true;
                    }
                } else {
                    showMessage('You must have a house here to build a city.', 'error');
                }
            } else {
                showMessage('Click near a junction with your house to build a city.', 'error');
            }
        } else if (selectedPlayerTool === 'road') {
            const clickedEdge = getClosestEdge(mouseX, mouseY);
            if (clickedEdge) {
                let existingRoad = false;
                for (const pId in allPlayersData) {
                    if (pId.startsWith('player')){
                        if (allPlayersData[pId].roads.some(r => r.edge.id === clickedEdge.id)) {
                            existingRoad = true;
                            break;
                        }
                    }
                }

                if (existingRoad) {
                    showMessage('A road already exists here.', 'error');
                } else {
                    if(checkAndDeductCards(PLAYER_ID,selectedPlayerTool))
                    {
                        savePlayerStateToHistory();
                        allPlayersData[PLAYER_ID].roads.push({ edge: clickedEdge, owner: PLAYER_ID });
                        showMessage(`${selectedPlayerTool} placed!`);
                        updatePlayerUI();
                        actionSuccessful = true;
                    }
                }
            } else {
                showMessage('Click near an edge to place a road.', 'error');
            }
        } else if (selectedPlayerTool === 'robber') {
            const clickedHex = pixelToHex(mouseX, mouseY, offsetX, offsetY);
            const clickedTile = boardTiles.find(t => t.q === clickedHex.q && t.r === clickedHex.r);
            if (clickedTile) {
                if (allPlayersData['robber'] && allPlayersData['robber'].q === clickedTile.q && allPlayersData['robber'].r === clickedTile.r) {
                    showMessage('Robber is already on this tile.', 'info');
                } else {
                    savePlayerStateToHistory();
                    allPlayersData['robber'] = clickedTile;
                    showMessage(`Robber moved to ${clickedTile.type} tile.`);
                    actionSuccessful = true;
                }
            } else {
                showMessage('Click on a tile to move the robber.', 'error');
            }
        }
    }

    if (actionSuccessful) {
        if (isPlayerPage) {
            console.log("trying to save playerstate");
            //await saveAllPlayerStatesToBackend();
            saveAllPlayerStatesToBackend();            
        }
    }
    drawBoard();
});

if (!isGamePage && !isPlayerPage) {
    document.getElementById('tool-select').addEventListener('click', (event) => {
        const target = event.target;
        if (target.classList.contains('btn-tool')) {
            document.querySelectorAll('.btn-tool').forEach(btn => btn.classList.remove('selected'));
            target.classList.add('selected');

            selectedTool = target.dataset.tool;

            if (selectedTool === 'undo') {
                undoBuilderLastAction();
            } else if (selectedTool === 'shuffle-cells') {
                shuffleCells();
            } else if (selectedTool === 'shuffle-numbers') {
                shuffleNumbers();
            } else if (selectedTool === 'save-board') {
                saveBoardTilesToBackend();
            } else if (selectedTool === 'load-board') {
                loadAllStatesFromBackend();
            }
            showMessage(`Selected tool: ${selectedTool}`);
            drawBoard();
        }
    });
}

if (isPlayerPage) {
    const playerNameInput = document.getElementById('playerNameInput');
    const savePlayerNameBtn = document.getElementById('savePlayerNameBtn');

    if (savePlayerNameBtn) {
        savePlayerNameBtn.addEventListener('click', async () => {
            const newName = playerNameInput.value.trim();
            if (newName) {
                allPlayersData[PLAYER_ID].playerName = newName;
                updatePlayerUI();
                await saveAllPlayerStatesToBackend(); 
                showMessage('Player name saved!');
            } else {
                showMessage('Player name cannot be empty.', 'error');
            }
        });
    }


    document.getElementById('player-tool-select').addEventListener('click', (event) => {
        const target = event.target;
        if (target.classList.contains('btn-tool')) {
            document.querySelectorAll('#player-tool-select .btn-tool').forEach(btn => btn.classList.remove('selected'));
            target.classList.add('selected');
            selectedPlayerTool = target.dataset.tool;

            if (selectedPlayerTool === 'undo-player') {
                undoPlayerLastAction();
            } else {
                showMessage(`Selected tool: ${selectedPlayerTool}. Click on the board to place.`);
            }
        }
    });



    const resourceCardButtons = document.querySelectorAll('.resource-card');
    resourceCardButtons.forEach(button => {
        button.addEventListener('click', async (event) => {
            const resourceType = event.target.dataset.resourceType;
            const confirmed = await showConfirmation(`Do you want to take 1 ${resourceType} card?`);
            if (confirmed) {
                savePlayerStateToHistory();
                allPlayersData[PLAYER_ID].hand.push(resourceType);
                // send player_id and resource-type
                socket.emit('card_pick_log', { 
                    pid: PLAYER_ID, 
                    log: resourceType
                });
                console.log(`Client: Before save, allPlayersData[${PLAYER_ID}].hand:`, JSON.stringify(allPlayersData[PLAYER_ID].hand));
                await saveAllPlayerStatesToBackend(); 
                showMessage(`You took 1 ${resourceType} card!`);
                updatePlayerUI(); // Update UI immediately after local state change
            } else {
                showMessage(`Cancelled taking ${resourceType} card.`);
            }
        });
    });

    const devCardButton = document.querySelector('.dev-card');
        
    devCardButton.addEventListener('click', async () => {
        const confirmed = await showConfirmation('Do you want to take 1 Development card?');
        
        if (confirmed) {
            if(checkAndDeductCards(PLAYER_ID,'dev')){
                if (globalDevCardDeck.length === 0) {
                    initializeDevCardDeck();
                    showMessage('Development card deck was empty, re-initialized and shuffled.');
                }
                if (globalDevCardDeck.length > 0) {
                    savePlayerStateToHistory();
                    const drawnCard = globalDevCardDeck.pop();
                    allPlayersData[PLAYER_ID].devCards.push(drawnCard);
                    await saveAllPlayerStatesToBackend(); 
                    showMessage(`You drew a ${drawnCard} Development Card!`);
                    updatePlayerUI(); // Update UI immediately after local state change
                }
            } else {
                showMessage('Required card not available. ');
            }
        }
        
    });
    document.querySelector('.player-decks-section').addEventListener('click', async (event) => {
        const target = event.target;
        if (target.classList.contains('transfer-btn') || target.classList.contains('drop-btn')) {
            const targetPlayerId = target.dataset.targetPlayer;
            if (selectedHandCards.length === 0) {
                showMessage('Please select cards from your hand first.', 'error');
                return;
            }

            let confirmationMessage = '';
            if (targetPlayerId === 'NA') {
                confirmationMessage = `Are you sure you want to drop ${selectedHandCards.length} selected card(s)?`;
            } else {
                const targetPlayerName = allPlayersData[targetPlayerId] ? allPlayersData[targetPlayerId].playerName : targetPlayerId;
                confirmationMessage = `Are you sure you want to transfer ${selectedHandCards.length} selected card(s) to ${targetPlayerName}?`;
            }

            const confirmed = await showConfirmation(confirmationMessage);
            if (confirmed) {
                await transferOrDropSelectedCards(PLAYER_ID, targetPlayerId);
            } else {
                showMessage('Card transfer/drop cancelled.');
            }
        }
    });

    
}

function checkAndDeductCards(playerId, actionType) {
    const playerHand = allPlayersData[playerId].hand;
    const requiredCards = CARD_COSTS[actionType];

    if (!requiredCards) {
        console.error(`Unknown action type: ${actionType}`);
        return false;
    }

    // Create a temporary count of cards in the player's hand
    const currentHandCounts = {};
    playerHand.forEach(card => {
        currentHandCounts[card] = (currentHandCounts[card] || 0) + 1;
    });

    // Check if player has enough cards
    for (const resourceType in requiredCards) {
        const requiredCount = requiredCards[resourceType];
        const availableCount = currentHandCounts[resourceType] || 0;
        if (availableCount < requiredCount) {
            showMessage(`Missing ${requiredCount - availableCount} ${resourceType} for ${actionType}.`, 'error');
            return false; // Not enough cards
        }
    }

    // If all checks pass, deduct the cards
    for (const resourceType in requiredCards) {
        const countToDeduct = requiredCards[resourceType];
        for (let i = 0; i < countToDeduct; i++) {
            const index = playerHand.indexOf(resourceType);
            if (index > -1) {
                playerHand.splice(index, 1); // Remove one instance of the card
            }
        }
    }
    console.log(`Deducted cards for ${actionType}. New hand:`, playerHand);
    return true; // Cards deducted successfully
}

function renderTransferDropButtons() {
    const transferDropButtonsDiv = document.getElementById('transferDropButtons');
    if (!transferDropButtonsDiv) return; // Exit if the container doesn't exist

    transferDropButtonsDiv.innerHTML = ''; // Clear existing buttons

    // Get player IDs for other players
    const otherPlayerIds = Object.keys(allPlayersData).filter(pId => pId !== PLAYER_ID && pId.startsWith('player'));

    // Create buttons for other players
    otherPlayerIds.forEach(pId => {
        const button = document.createElement('button');
        button.classList.add('btn', 'btn-tool', 'transfer-btn');
        button.dataset.targetPlayer = pId;
        button.textContent = `${allPlayersData[pId].playerName}`;
        transferDropButtonsDiv.appendChild(button);
    });

    // Create the "Drop Selected" button
    const dropButton = document.createElement('button');
    dropButton.classList.add('btn', 'btn-tool', 'drop-btn');
    dropButton.dataset.targetPlayer = 'NA';
    dropButton.textContent = 'Drop Selected';
    transferDropButtonsDiv.appendChild(dropButton);
}
function initializeDevCardDeck() {
    const devCardTypes = {
        'knight': 14,
        'victory_point': 5,
        'road_building': 2,
        'year_of_plenty': 2,
        'monopoly': 2
    };
    globalDevCardDeck = [];
    for (const type in devCardTypes) {
        for (let i = 0; i < devCardTypes[type]; i++) {
            globalDevCardDeck.push(type);
        }
    }
    shuffleArray(globalDevCardDeck);
}

function resizeCanvas() {
    const containerWidth = canvas.parentElement.clientWidth;
    const containerHeight = canvas.parentElement.clientHeight;

    const aspectRatio = 1.2 / 1;
    let newWidth = containerWidth;
    let newHeight = newWidth / aspectRatio;

    if (newHeight > containerHeight) {
        newHeight = containerHeight;
        newWidth = newHeight * aspectRatio;
    }

    canvas.width = newWidth;
    canvas.height = newHeight;

    let minRawX = Infinity, maxRawX = -Infinity, minRawY = Infinity, maxRawY = -Infinity;
    if (boardTiles.length > 0) {
        boardTiles.forEach(tile => {
            const rawPixel = hexToRawPixel(tile.q, tile.r);
            const vertices = getHexVertices(rawPixel.x, rawPixel.y, TILE_RADIUS);
            vertices.forEach(v => {
                minRawX = Math.min(minRawX, v.x);
                maxRawX = Math.max(maxRawX, v.x);
                minRawY = Math.min(minRawY, v.y);
                maxRawY = Math.max(maxRawY, v.y);
            });
        });

        const boardActualWidth = maxRawX - minRawX;
        const boardActualHeight = maxRawY - minRawY;

        offsetX = (canvas.width / 2) - (minRawX + boardActualWidth / 2);
        offsetY = (canvas.height / 2) - (minRawY + boardActualHeight / 2);

        boardCenterRawX = minRawX + boardActualWidth / 2;
        boardCenterRawY = minRawY + boardActualHeight / 2;
    } else {
        offsetX = canvas.width / 2;
        offsetY = canvas.height / 2;
        boardCenterRawX = 0;
        boardCenterRawY = 0;
    }

    drawBoard();
}

function updatePlayerUI() {
    if (!isPlayerPage || !allPlayersData[PLAYER_ID]) return;

    const playerNameInput = document.getElementById('playerNameInput');
    const playerNameDisplay = document.getElementById('playerNameDisplay');
    if (playerNameInput) playerNameInput.value = allPlayersData[PLAYER_ID].playerName;
    if (playerNameDisplay) playerNameDisplay.textContent = allPlayersData[PLAYER_ID].playerName;

    const handCardsDiv = document.getElementById('handCards');
    if (handCardsDiv) {
        handCardsDiv.innerHTML = '';
        
        // Iterate directly over the hand array to create individual cards
        allPlayersData[PLAYER_ID].hand.forEach(resourceType => {
            const cardItem = document.createElement('div');
            cardItem.classList.add('card-item');
            cardItem.classList.add('resource-card'); // Add resource-card class for background image styling
            cardItem.classList.add('animate-in'); // Keep animation
            cardItem.dataset.resourceType = resourceType; // Set data-resource-type for CSS background image
            // No textContent needed for resource cards as per CSS (display: none for .card-text)
            cardItem.addEventListener('click', () => toggleCardSelection(cardItem, resourceType));

            // Apply 'selected' class if the card is in the selectedHandCards array
            //if (selectedHandCards.includes(resourceType)) {
              //  cardItem.classList.add('selected');
            //}
            
            handCardsDiv.appendChild(cardItem);
        });
        document.getElementById('handCardCount').textContent = allPlayersData[PLAYER_ID].hand.length;
        console.log(`Client: updatePlayerUI - Hand cards rendered. Current hand: ${JSON.stringify(allPlayersData[PLAYER_ID].hand)}`);
    }

    const devCardsDiv = document.getElementById('devCards');
    if (devCardsDiv) {
            devCardsDiv.innerHTML = '';
            allPlayersData[PLAYER_ID].devCards.forEach(cardType => { // Changed 'card' to 'cardType' for clarity
                const cardItem = document.createElement('div');
                cardItem.classList.add('card-item');
                cardItem.classList.add('dev-card'); // Add dev-card class for background image styling
                cardItem.classList.add('animate-in'); // Add animation for dev cards too
                cardItem.dataset.cardType = cardType; // Set data-resource-type based on the card type
                cardItem.addEventListener('click', () => playdevcard(PLAYER_ID, cardType));
                devCardsDiv.appendChild(cardItem);
            }
        );
        document.getElementById('devCardCount').textContent = allPlayersData[PLAYER_ID].devCards.length;}
        const playerNameInputGroup = document.querySelector('.player-info-section');
        if (playerNameInput.value && !playerNameInput.value.startsWith('Player')) {
            if (playerNameInputGroup) {
                playerNameInputGroup.classList.add('hidden');
            }
        }
        renderTransferDropButtons();
}
function toggleCardSelection(cardElement, resourceType) {
    cardElement.classList.toggle('selected');
    const handCardsDiv = document.getElementById('handCards');
    if (!handCardsDiv) {
        console.warn("Element with ID 'handCards' not found.");
    }
    selectedHandCards=[];
    const allCardItems = handCardsDiv.querySelectorAll('.card-item');
    allCardItems.forEach(cardItem => {
        if (cardItem.classList.contains('selected')) {
            const resourceType = cardItem.dataset.resourceType;
            if (resourceType) {
                selectedHandCards.push(resourceType);
            }
        }
    });
    document.getElementById('selectedCardCount').textContent = selectedHandCards.length;
    console.log('Selected cards:', selectedHandCards);
}
async function transferOrDropSelectedCards(currentPlayerId, targetPlayerId) {
    if (selectedHandCards.length === 0) {
        showMessage('No cards selected to transfer/drop.', 'error');
        return;
    }
    //console.log(currentPlayerId+"=>"+targetPlayerId);
    savePlayerStateToHistory(); // Save current state before modification
    selectedHandCards.forEach(item => {
        console.log('item'+item);
        if (targetPlayerId !== 'NA' && allPlayersData[targetPlayerId]) {
            allPlayersData[targetPlayerId].hand.push(item);
            const index = allPlayersData[currentPlayerId].hand.indexOf(item);
            if (index > -1) {
                allPlayersData[currentPlayerId].hand.splice(index, 1); 
            }
            showMessage(`Transferred 1 ${item} to ${allPlayersData[targetPlayerId].playerName}.`);
        } else if (targetPlayerId === 'NA') {
            const index = allPlayersData[currentPlayerId].hand.indexOf(item);
            if (index > -1) {
                allPlayersData[currentPlayerId].hand.splice(index, 1); 
            }
            showMessage(`Dropped 1 ${item}.`);
        }
    });

    selectedHandCards = [];
    await saveAllPlayerStatesToBackend(); // Save changes to backend
    updatePlayerUI(); 
    showMessage('Card operation completed.');
}

function addDisappearingTag(containerDiv, text) {
            const tag = document.createElement('span');
            tag.className = 'tag';
            tag.textContent = text;
            containerDiv.appendChild(tag);
            setTimeout(() => {
                tag.classList.add('fade-out');
                setTimeout(() => {
                    if (tag.parentNode) {
                        tag.parentNode.removeChild(tag);
                    }
                }, 300); 
            }, 60000); 
        }

async function playdevcard(currentPlayerId, item) {
    alert(item);
    const confirmed = await showConfirmation(`Are you sure you want to play the ${item} card?`);
    if (confirmed) {
        savePlayerStateToHistory(); // Save state before playing
        const index = allPlayersData[currentPlayerId].devCards.indexOf(item);
        if (index > -1) {
            allPlayersData[currentPlayerId].devCards.splice(index, 1); 
        }
            
        socket.emit('dev_card_played', { 
            cardType: item, 
            playerName: allPlayersData[currentPlayerId].playerName 
        });
            
            await saveAllPlayerStatesToBackend(); // Save changes to backend
            updatePlayerUI(); // Update UI immediately
        } else {
            showMessage('Error: Could not find the specific card to play.', 'error');
            undoPlayerLastAction(); 
        }
}

async function onCatanPlayerPageLoad() {
    await loadAllStatesFromBackend();
    updatePlayerUI();
    if (allPlayersData[PLAYER_ID] && allPlayersData[PLAYER_ID].history.length === 0) {
        savePlayerStateToHistory();
    }
}

socket.on('catan_update', async () => {
    console.log('Received catan_update from server. Reloading state...');
    // Reload all states from the backend and update the UI
    await loadAllStatesFromBackend();
    updatePlayerUI();
    showMessage('Game state updated by another player!');
});

socket.on('dev_card_played_broadcast', (data) => {
    if (isGamePage) {
        const playedCardsContainer = document.getElementById('playedDevCards');
        if (playedCardsContainer) {
            const cardElement = document.createElement('div');
            cardElement.classList.add('played-card-item');
            cardElement.classList.add('dev-card'); // Use dev-card styling
            cardElement.dataset.resourceType = data.cardType; // For background image
            cardElement.innerHTML = `
                <span class="card-text">${data.cardType.replace('_', ' ').toUpperCase()}</span>
                <p>${data.playerName}</p>
            `;
            playedCardsContainer.appendChild(cardElement);
            showMessage(`${data.playerName} played a ${data.cardType.replace('_', ' ')} card!`);
        }
    }
});

socket.on('card_pick_log_broadcast', (data) => {
    if (isGamePage) {
        const playedCardsContainerh = document.getElementById(data.pid+'logh');
        const playedCardsContainer = document.getElementById(data.pid+'log');
        if (playedCardsContainer) {
            playedCardsContainerh.innerHTML = allPlayersData[data.pid].playerName
            addDisappearingTag(playedCardsContainer,data.log);
            
        }
    }
});

window.addEventListener('load', async () => {
    await preloadImages();
    if (!isGamePage && !isPlayerPage) {
        saveBuilderState();
    } else if (isPlayerPage) {
        onCatanPlayerPageLoad();
    }
});
window.addEventListener('resize', resizeCanvas);
