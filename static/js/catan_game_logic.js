const canvas = document.getElementById('catanBoard');
const ctx = canvas.getContext('2d');
const messageBox = document.getElementById('messageBox');

const isGamePage = window.location.pathname === '/catan/game';
const isPlayerPage = window.location.pathname.startsWith('/catan/player/');

const PLAYER_ID = isPlayerPage && window.PLAYER_ID ? 'player' + window.PLAYER_ID : null;


let loadedResourceImages = {};
let boardTiles = [];
let boardEditingAllowed = document.body.dataset.boardEditable === 'true';
let mapZoomLevel = 1;
let selectedHandCards  = [];
let pendingResourceCards = [];
let diceAnimationInterval = null;
let diceAnimationTimeout = null;
let diceOverlayHideTimeout = null;

const socket = io();
let init_player_data = {
    'player1': { playerName: 'Player 1', hand: ["wood", "brick", "sheep", "hay", "wood", "brick", "wood", "brick", "wood", "brick", "sheep", "hay"], devCards: [], roads: [], structures: [], history: [],longestroad: 0,largestarmy:0,knightplayed:0,merchant:0,victory_point:0,score:0 },
    'player2': { playerName: 'Player 2', hand: ["wood", "brick", "sheep", "hay", "wood", "brick", "wood", "brick", "wood", "brick", "sheep", "hay"], devCards: [], roads: [], structures: [], history: [],longestroad: 0,largestarmy:0,knightplayed:0,merchant:0,victory_point:0,score:0 },
    'player3': { playerName: 'Player 3', hand: ["wood", "brick", "sheep", "hay", "wood", "brick", "wood", "brick", "wood", "brick", "sheep", "hay"], devCards: [], roads: [], structures: [], history: [],longestroad: 0,largestarmy:0,knightplayed:0,merchant:0,victory_point:0,score:0 },
    'player4': { playerName: 'Player 4', hand: ["wood", "brick", "sheep", "hay", "wood", "brick", "wood", "brick", "wood", "brick", "sheep", "hay"], devCards: [], roads: [], structures: [], history: [],longestroad: 0,largestarmy:0,knightplayed:0,merchant:0,victory_point:0,score:0 },
    'robber':{q:100,r:100}
}; 
let allPlayersData = init_player_data;
allPlayersData._turnOrder = [];
allPlayersData._currentTurnPlayerId = null;
const CARD_COSTS = {
    'road': { 'wood': 1, 'brick': 1 },
    'house': { 'wood': 1, 'brick': 1, 'sheep': 1, 'hay': 1 },
    'city': { 'rock': 3, 'hay': 2 },
    'dev': { 'rock': 1, 'sheep': 1, 'hay': 1 }
};
const PLAYER_PIECE_LIMITS = { house: 5, city: 4, road: 15 };
let globalDevCardDeck = [];

let offsetX = 0;
let offsetY = 0;
let boardScale = 1;

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

const mapZoomToggle = document.getElementById('mapZoomToggle');
if (mapZoomToggle) {
    mapZoomToggle.addEventListener('click', () => {
        mapZoomLevel = mapZoomLevel === 1 ? 2 : 1;
        const zoomViewport = document.querySelector('.map-zoom-viewport');
        zoomViewport.classList.toggle('map-zoomed', mapZoomLevel === 2);
        mapZoomToggle.setAttribute('aria-pressed', String(mapZoomLevel === 2));
        mapZoomToggle.textContent = mapZoomLevel === 2 ? 'Fit' : '2×';
        mapZoomToggle.title = mapZoomLevel === 2 ? 'Return map to fit' : 'Zoom map to 2x';
        resizeCanvas();
        zoomViewport.scrollLeft = 0;
    });
}

function showMessage(message, type = 'info') {
    if (isGamePage) {
        const notification = document.createElement('div');
        notification.className = `game-toast ${type === 'error' ? 'game-toast-error' : 'game-toast-info'}`;
        notification.textContent = message;
        messageBox.appendChild(notification);
        void messageBox.offsetHeight;
        messageBox.scrollTop = messageBox.scrollHeight;
        window.setTimeout(() => notification.remove(), 30000);
        window.requestAnimationFrame(() => {
            messageBox.scrollTop = messageBox.scrollHeight;
        });
        return;
    }

    messageBox.textContent = message;
    messageBox.className = `message-box ${type === 'error' ? 'bg-red-100 text-red-800 border-red-300' : 'bg-yellow-100 text-yellow-800 border-orange-300'}`;
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
    ctx.save();
    ctx.scale(boardScale, boardScale);

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

            drawCirclePort(ctx, portDrawX, portDrawY, type, ratio);
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
    ctx.restore();
}

function saveBuilderState() {
    if (isGamePage || isPlayerPage || !boardEditingAllowed) return;

    builderHistoryStack.push({
        tileStates: JSON.parse(JSON.stringify(boardTiles.map(tile => ({ q: tile.q, r: tile.r, type: tile.type, number: tile.number })))),
        robber: allPlayersData['robber'] ? JSON.parse(JSON.stringify(allPlayersData['robber'])) : null,
    });
}

function updateBoardEditingUI() {
    if (isGamePage || isPlayerPage) return;
    const status = document.getElementById('boardEditStatus');
    if (status) {
        status.textContent = boardEditingAllowed
            ? 'Board editing is available.'
            : 'Game in progress. Reset the game to edit the board.';
    }
    document.querySelectorAll('#tool-select .btn-tool').forEach(button => {
        const canAlwaysReset = button.dataset.tool === 'reset-game';
        button.disabled = !boardEditingAllowed && !canAlwaysReset;
        button.setAttribute('aria-disabled', String(button.disabled));
    });
}

function undoBuilderLastAction() {
    if (isGamePage || isPlayerPage) return;
    if (!boardEditingAllowed) {
        showMessage('Reset the game before editing the board.', 'error');
        return;
    }

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
        saveBoardTilesToBackend();
    } else {
        showMessage('No more actions to undo.', 'error');
    }
}

function savePlayerStateToHistory() {
    if (!isPlayerPage || !allPlayersData[PLAYER_ID]) return;

    const undoStack = Array.isArray(allPlayersData._undoStack) ? allPlayersData._undoStack : [];
    const state = JSON.parse(JSON.stringify(allPlayersData));
    delete state._undoStack;
    undoStack.push({ state, devCardDeck: [...globalDevCardDeck] });
    if (undoStack.length > 3) undoStack.shift();
    allPlayersData._undoStack = undoStack;
    updateUndoButton();
}

function updateUndoButton() {
    const button = document.querySelector('#player-tool-select [data-tool="undo-player"]');
    if (!button) return;
    const undoCount = Array.isArray(allPlayersData._undoStack) ? allPlayersData._undoStack.length : 0;
    button.disabled = undoCount === 0;
    button.title = undoCount > 0 ? `Undo last action (${undoCount} available)` : 'Undo unavailable';
    button.setAttribute('aria-disabled', String(undoCount === 0));
}

function updateRollButton() {
    const button = document.getElementById('rolldice');
    if (!button) return;

    const currentPlayerId = allPlayersData._currentTurnPlayerId;
    const canRoll = isPlayerPage && currentPlayerId === PLAYER_ID;
    const currentPlayerName = allPlayersData[currentPlayerId]?.playerName || 'the next player';
    button.disabled = !canRoll;
    button.title = canRoll ? 'Roll dice' : `Waiting for ${currentPlayerName} to roll`;
    button.setAttribute('aria-label', button.title);
}

async function undoPlayerLastAction() {
    const undoStack = Array.isArray(allPlayersData._undoStack) ? allPlayersData._undoStack : [];
    if (!isPlayerPage || undoStack.length === 0) {
        showMessage('No actions to undo since the last dice roll.', 'error');
        updateUndoButton();
        return;
    }

    const snapshot = undoStack.pop();
    allPlayersData = JSON.parse(JSON.stringify(snapshot.state));
    allPlayersData._undoStack = undoStack;
    globalDevCardDeck = [...(snapshot.devCardDeck || [])];
    selectedHandCards = [];
    pendingResourceCards = [];
    selectedPlayerTool = null;
    const selectedCardCount = document.getElementById('selectedCardCount');
    if (selectedCardCount) selectedCardCount.textContent = '0';
    updateLargestArmyHolder();
    updateLongestRoadHolder();
    showMessage('Last action undone.');
    drawBoard();
    updatePlayerUI();
    await saveAllPlayerStatesToBackend();
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

function shuffleCells() {
    if (isGamePage || isPlayerPage) return;
    if (!boardEditingAllowed) {
        showMessage('Reset the game before editing the board.', 'error');
        return;
    }

    const nonDesertTiles = boardTiles.filter(tile => tile.type !== 'desert');
    const resourceTypes = nonDesertTiles.map(tile => tile.type);
    const assignments = assignBoardValues(nonDesertTiles, resourceTypes, (first, second) => first === second);
    if (!assignments) {
        showMessage('Could not shuffle resources without adjacent matches. Keep the current board or change its resource counts.', 'error');
        return;
    }

    saveBuilderState();
    nonDesertTiles.forEach((tile, index) => {
        tile.type = assignments[index];
    });

    showMessage('Cells shuffled with adjacent matches avoided.');
    drawBoard();
    saveBoardTilesToBackend();
}

function numberTokensConflict(first, second) {
    return first === second || ([6, 8].includes(first) && [6, 8].includes(second));
}

function assignBoardValues(tiles, values, valuesConflict) {
    if (tiles.length !== values.length) return null;

    const coordinateIndices = new Map(tiles.map((tile, index) => [`${tile.q},${tile.r}`, index]));
    const directions = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];
    const neighbors = tiles.map(tile => directions
        .map(([deltaQ, deltaR]) => coordinateIndices.get(`${tile.q + deltaQ},${tile.r + deltaR}`))
        .filter(index => index !== undefined));
    const remainingCounts = new Map();
    values.forEach(value => {
        remainingCounts.set(value, (remainingCounts.get(value) || 0) + 1);
    });

    const assignments = new Array(tiles.length).fill(undefined);

    function getCandidates(tileIndex) {
        return [...remainingCounts.entries()]
            .filter(([value, count]) => count > 0 && neighbors[tileIndex].every(neighborIndex =>
                assignments[neighborIndex] === undefined || !valuesConflict(value, assignments[neighborIndex])
            ))
            .map(([value]) => value);
    }

    function assignValues(assignedCount) {
        if (assignedCount === tiles.length) return true;

        let selectedTile = -1;
        let selectedCandidates = null;
        for (let tileIndex = 0; tileIndex < assignments.length; tileIndex++) {
            if (assignments[tileIndex] !== undefined) continue;
            const candidates = getCandidates(tileIndex);
            if (candidates.length === 0) return false;
            if (selectedCandidates === null || candidates.length < selectedCandidates.length) {
                selectedTile = tileIndex;
                selectedCandidates = candidates;
            } else if (candidates.length === selectedCandidates.length && Math.random() < 0.5) {
                selectedTile = tileIndex;
                selectedCandidates = candidates;
            }
        }

        shuffleArray(selectedCandidates);
        for (const value of selectedCandidates) {
            assignments[selectedTile] = value;
            remainingCounts.set(value, remainingCounts.get(value) - 1);
            if (assignValues(assignedCount + 1)) return true;
            remainingCounts.set(value, remainingCounts.get(value) + 1);
            assignments[selectedTile] = undefined;
        }
        return false;
    }

    return assignValues(0) ? assignments : null;
}

function shuffleNumbers() {
    if (isGamePage || isPlayerPage) return;
    if (!boardEditingAllowed) {
        showMessage('Reset the game before editing the board.', 'error');
        return;
    }

    const nonDesertTiles = boardTiles.filter(tile => tile.type !== 'desert');
    const numbers = nonDesertTiles.map(tile => tile.number);
    const assignments = assignBoardValues(nonDesertTiles, numbers, numberTokensConflict);
    if (!assignments) {
        showMessage('Could not shuffle numbers without adjacent repeats. Keep the current board or change its tokens.', 'error');
        return;
    }

    saveBuilderState();
    nonDesertTiles.forEach((tile, index) => {
        tile.number = assignments[index];
    });
    showMessage('Numbers shuffled with adjacent repeats avoided.');
    drawBoard();
    saveBoardTilesToBackend();
}

async function saveBoardTilesToBackend() {
    if (isGamePage || isPlayerPage || !boardEditingAllowed) {
        showMessage('Reset the game before editing the board.', 'error');
        return false;
    }

    try {
        const boardTilesState = {
            boardTiles: boardTiles.map(tile => ({
                q: tile.q,
                r: tile.r,
                type: tile.type,
                number: tile.number
            })),
        };
        const response = await fetch('/catan/save_board', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(boardTilesState),
        });
        const result = await response.json();
        if (result.status === 'success') {
            return true;
        } else {
            if (response.status === 409) {
                boardEditingAllowed = false;
                updateBoardEditingUI();
                await loadBoardTilesFromBackend();
            }
            showMessage('Error saving board tiles: ' + result.message, 'error');
            return false;
        }
    } catch (e) {
        showMessage('Network error saving board tiles: ' + e.message, 'error');
        console.error('Error saving board tiles to backend:', e);
        return false;
    }
}

async function loadBoardTilesFromBackend() {
    try {
        const response = await fetch('/catan/load_board');
        const result = await response.json();
        boardEditingAllowed = result.editable === true;
        updateBoardEditingUI();
        if (result.status === 'success' && result.board_state) {
            boardTiles = result.board_state.boardTiles;
            if (!isGamePage && !isPlayerPage) {
                saveBuilderState();
            }
            if (!isGamePage) showMessage('Board tiles loaded successfully!');
        } else {
            showMessage((result.message || "No saved board tiles found.") + ' Displaying default board tiles.', 'info');
            boardTiles = [
                { q: 0, r: -2, type: 'rock', number: 10 },
                { q: 1, r: -2, type: 'sheep', number: 2 },
                { q: 2, r: -2, type: 'wood', number: 9 },
                { q: -1, r: -1, type: 'brick', number: 12 },
                { q: 0, r: -1, type: 'hay', number: 6 },
                { q: 1, r: -1, type: 'rock', number: 4 },
                { q: 2, r: -1, type: 'wood', number: 10 },
                { q: -2, r: 0, type: 'wood', number: 9 },
                { q: -1, r: 0, type: 'sheep', number: 11 },
                { q: 0, r: 0, type: 'desert', number: null },
                { q: 1, r: 0, type: 'brick', number: 3 },
                { q: 2, r: 0, type: 'hay', number: 8 },
                { q: -2, r: 1, type: 'rock', number: 8 },
                { q: -1, r: 1, type: 'hay', number: 3 },
                { q: 0, r: 1, type: 'wood', number: 4 },
                { q: 1, r: 1, type: 'sheep', number: 5 },
                { q: -2, r: 2, type: 'brick', number: 5 },
                { q: -1, r: 2, type: 'sheep', number: 6 },
                { q: 0, r: 2, type: 'hay', number: 11 }
            ];
            if (!isGamePage && !isPlayerPage) {
                saveBuilderState();
            }
        }
        allJunctions = getAllJunctions();
        allEdges = getAllEdges();
        resizeCanvas();
    } catch (e) {
        boardEditingAllowed = false;
        updateBoardEditingUI();
        showMessage('Network error loading board tiles: ' + e.message + '. Displaying default board tiles.', 'error');
        console.error('Error loading board tiles from backend:', e);
        boardTiles = [
            { q: 0, r: -2, type: 'rock', number: 10 },
            { q: 1, r: -2, type: 'sheep', number: 2 },
            { q: 2, r: -2, type: 'wood', number: 9 },
            { q: -1, r: -1, type: 'brick', number: 12 },
            { q: 0, r: -1, type: 'hay', number: 6 },
            { q: 1, r: -1, type: 'rock', number: 4 },
            { q: 2, r: -1, type: 'wood', number: 10 },
            { q: -2, r: 0, type: 'wood', number: 9 },
            { q: -1, r: 0, type: 'sheep', number: 11 },
            { q: 0, r: 0, type: 'desert', number: null },
            { q: 1, r: 0, type: 'brick', number: 3 },
            { q: 2, r: 0, type: 'hay', number: 8 },
            { q: -2, r: 1, type: 'rock', number: 8 },
            { q: -1, r: 1, type: 'hay', number: 3 },
            { q: 0, r: 1, type: 'wood', number: 4 },
            { q: 1, r: 1, type: 'sheep', number: 5 },
            { q: -2, r: 2, type: 'brick', number: 5 },
            { q: -1, r: 2, type: 'sheep', number: 6 },
            { q: 0, r: 2, type: 'hay', number: 11 }
        ];
        allJunctions = getAllJunctions();
        allEdges = getAllEdges();
        resizeCanvas();
    }
}

async function saveAllPlayerStatesToBackend(forceSave = false) {
    if (!isGamePage || forceSave) {
        try {
            const response = await fetch('/catan/save_play_state', {
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
        const response = await fetch('/catan/load_play_state');
        
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
                    allPlayersData[pId].longestroad = Number(loadedStates[pId].longestroad) || 0;
                    allPlayersData[pId].longestroadmanual = Number(loadedStates[pId].longestroadmanual) || 0;
                    allPlayersData[pId].largestarmy = Number(loadedStates[pId].largestarmy) || 0;
                    allPlayersData[pId].largestarmymanual = Number(loadedStates[pId].largestarmymanual) || 0;
                    allPlayersData[pId].knightplayed = Number(loadedStates[pId].knightplayed) || 0;
                    allPlayersData[pId].victory_point = Number(loadedStates[pId].victory_point) || 0;
                }
            }
            allPlayersData['robber']=loadedStates['robber'] || {q:100,r:100};
            allPlayersData._undoStack = Array.isArray(loadedStates._undoStack) ? loadedStates._undoStack.slice(-3) : [];
            allPlayersData._turnOrder = Array.isArray(loadedStates._turnOrder) ? loadedStates._turnOrder : [];
            allPlayersData._currentTurnPlayerId = loadedStates._currentTurnPlayerId || allPlayersData._turnOrder[0] || null;
            if (!isGamePage) showMessage('All player states loaded successfully!');
        } else {
            showMessage("No saved player states found. Initializing default player states.", 'info');
            allPlayersData = init_player_data;
            allPlayersData._undoStack = [];
            allPlayersData._turnOrder = [];
            allPlayersData._currentTurnPlayerId = null;
        }
        drawBoard();
    } catch (e) {
        showMessage('Network error loading player states: ' + e.message + '. Initializing default player states.', 'error');
        console.error('Error loading player states from backend:', e);
        allPlayersData = init_player_data;
        allPlayersData._undoStack = [];
        allPlayersData._turnOrder = [];
        allPlayersData._currentTurnPlayerId = null;
        drawBoard();
    }
}
async function loadAllStatesFromBackend() {
    console.log("loading data");
    await loadBoardTilesFromBackend();
    await loadAllPlayerStatesFromBackend();
    updateLargestArmyHolder();
    updateLongestRoadHolder();
    if (isGamePage) calculatepointsandcards();
    //await loadRobberStateFromBackend();
    drawBoard();
}
async function resetgame()
{
    try {
            const response = await fetch('/catan/reset_game', {

            });
            const result = await response.json();
            if (result.status === 'success') {
                showMessage(result.message);
            } else {
                console.error('Error reseting game:', result.message);
                showMessage('Error reseting game: ' + result.message, 'error');
            }
        } catch (e) {
            console.error('Network error:', e);
            showMessage('Network error reseting game: ' + e.message, 'error');
        }
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

function getLongestRoadLength(playerId) {
    const roads = (allPlayersData[playerId].roads || []).map(road => road.edge).filter(Boolean);
    const connections = new Map();

    roads.forEach(edge => {
        const start = `${Math.round(edge.x1)},${Math.round(edge.y1)}`;
        const end = `${Math.round(edge.x2)},${Math.round(edge.y2)}`;
        const id = edge.id || [start, end].sort().join('-');
        if (!connections.has(start)) connections.set(start, []);
        if (!connections.has(end)) connections.set(end, []);
        connections.get(start).push({ id, next: end });
        connections.get(end).push({ id, next: start });
    });

    const blockedJunctions = new Set();
    Object.keys(allPlayersData).forEach(otherPlayerId => {
        if (!otherPlayerId.startsWith('player') || otherPlayerId === playerId) return;
        (allPlayersData[otherPlayerId].structures || []).forEach(structure => {
            if (structure.type === 'house' || structure.type === 'city') {
                blockedJunctions.add(structure.junction.id);
            }
        });
    });

    function walk(junctionId, usedRoads) {
        if (usedRoads.size > 0 && blockedJunctions.has(junctionId)) return 0;
        let longest = 0;
        for (const connection of connections.get(junctionId) || []) {
            if (usedRoads.has(connection.id)) continue;
            usedRoads.add(connection.id);
            longest = Math.max(longest, 1 + walk(connection.next, usedRoads));
            usedRoads.delete(connection.id);
        }
        return longest;
    }

    let longest = 0;
    for (const junctionId of connections.keys()) {
        longest = Math.max(longest, walk(junctionId, new Set()));
    }
    return longest;
}

function updateLongestRoadHolder() {
    const playerIds = ['player1', 'player2', 'player3', 'player4'];
    const lengths = Object.fromEntries(playerIds.map(playerId => [playerId, getLongestRoadLength(playerId)]));
    const highestLength = Math.max(0, ...Object.values(lengths));
    const currentHolder = playerIds.find(playerId => allPlayersData[playerId].longestroad);

    if (currentHolder) {
        if (allPlayersData[currentHolder].longestroadmanual) return;
        const holderLength = lengths[currentHolder];
        if (holderLength >= 5 && highestLength <= holderLength) return;
        if (holderLength < 5) {
            playerIds.forEach(playerId => {
                allPlayersData[playerId].longestroad = 0;
                allPlayersData[playerId].longestroadmanual = 0;
            });
        }
    }
    if (highestLength < 5) return;

    const leaders = playerIds.filter(playerId => lengths[playerId] === highestLength);
    if (leaders.length !== 1) return;

    playerIds.forEach(playerId => {
        allPlayersData[playerId].longestroad = playerId === leaders[0] ? 1 : 0;
        allPlayersData[playerId].longestroadmanual = 0;
    });
}

function areJunctionsAdjacent(firstJunction, secondJunction) {
    return allEdges.some(edge => {
        const startId = `${Math.round(edge.x1)},${Math.round(edge.y1)}`;
        const endId = `${Math.round(edge.x2)},${Math.round(edge.y2)}`;
        return (startId === firstJunction.id && endId === secondJunction.id)
            || (startId === secondJunction.id && endId === firstJunction.id);
    });
}

function hasAdjacentSettlement(junction) {
    return Object.keys(allPlayersData).some(playerId => {
        if (!playerId.startsWith('player')) return false;
        return allPlayersData[playerId].structures.some(structure =>
            (structure.type === 'house' || structure.type === 'city')
            && areJunctionsAdjacent(junction, structure.junction)
        );
    });
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

canvas.addEventListener('click', async (event) => {
    if (!isGamePage && !isPlayerPage && !boardEditingAllowed) {
        showMessage('Reset the game before editing the board.', 'error');
        return;
    }

    const rect = canvas.getBoundingClientRect();
    console.log("rect size: "+rect.width+":"+rect.height);
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mouseX = (event.clientX - rect.left) * scaleX / boardScale;
    const mouseY = (event.clientY - rect.top) * scaleY / boardScale;

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
            const houseCount = (allPlayersData[PLAYER_ID].structures || []).filter(
                structure => structure.type === 'house'
            ).length;
            if (houseCount >= PLAYER_PIECE_LIMITS.house) {
                showMessage('You have no houses left. Upgrade one of your houses to a city before building another.', 'error');
                return;
            }
            
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
            const cityCount = (allPlayersData[PLAYER_ID].structures || []).filter(
                structure => structure.type === 'city'
            ).length;
            if (cityCount >= PLAYER_PIECE_LIMITS.city) {
                showMessage('You have already placed all 4 cities.', 'error');
                return;
            }

                    showMessage('A structure already exists here.', 'error');
                } else if (hasAdjacentSettlement(clickedJunction)) {
                    showMessage('A house or city must be at least two intersections away from another settlement.', 'error');
                } else {
                    //function to add items to the board
                    if(checkAndDeductCards(PLAYER_ID,selectedPlayerTool,true))
                    {
                        allPlayersData[PLAYER_ID].structures.push({ type: selectedPlayerTool, junction: clickedJunction, owner: PLAYER_ID });
                        showMessage(`${selectedPlayerTool} placed!`);
                const roadCount = (allPlayersData[PLAYER_ID].roads || []).length;
                if (roadCount >= PLAYER_PIECE_LIMITS.road) {
                    showMessage('You have already placed all 15 roads.', 'error');
                    return;
                }

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
                    if(checkAndDeductCards(PLAYER_ID,selectedPlayerTool,true))
                    {
                        existingHouse.type = 'city';
                        showMessage(`${selectedPlayerTool} placed!`);
                        updatePlayerUI();
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
                    if(checkAndDeductCards(PLAYER_ID,selectedPlayerTool,true))
                    {
                        allPlayersData[PLAYER_ID].roads.push({ edge: clickedEdge, owner: PLAYER_ID });
                        updateLongestRoadHolder();
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
            const actionMessages = {
                house: 'built a house',
                city: 'upgraded a house to a city',
                road: 'built a road',
                robber: 'moved the robber'
            };
            socket.emit('game_action_log', {
                pid: PLAYER_ID,
                message: actionMessages[selectedPlayerTool] || 'performed a game action'
            });
            console.log("trying to save playerstate");
            //await saveAllPlayerStatesToBackend();
            saveAllPlayerStatesToBackend();  
            //fix : add code to show in game play. 
        } else if (!isGamePage) {
            await saveBoardTilesToBackend();
        }
    }
    drawBoard();
});

if (!isGamePage && !isPlayerPage) {
    document.getElementById('tool-select').addEventListener('click', (event) => {
        const target = event.target;
        if (target.classList.contains('btn-tool')) {
            if (!boardEditingAllowed && target.dataset.tool !== 'reset-game') {
                showMessage('Reset the game before editing the board.', 'error');
                return;
            }
            document.querySelectorAll('.btn-tool').forEach(btn => btn.classList.remove('selected'));
            target.classList.add('selected');

            selectedTool = target.dataset.tool;

            if (selectedTool === 'undo') {
                undoBuilderLastAction();
            } else if (selectedTool === 'shuffle-cells') {
                shuffleCells();
            } else if (selectedTool === 'shuffle-numbers') {
                shuffleNumbers();
            } else if (selectedTool === 'reset-game') {
                resetgame();
            }
            
            
            showMessage(`Selected tool: ${selectedTool}`);
            drawBoard();
        }
    });
}

if (isPlayerPage) {
    document.getElementById('player-tool-select').addEventListener('click', (event) => {
        const target = event.target.closest('.btn-tool');
        if (!target || target.id === 'rolldice') return;

        document.querySelectorAll('#player-tool-select .btn-tool').forEach(btn => btn.classList.remove('selected'));
        target.classList.add('selected');
        selectedPlayerTool = target.dataset.tool;
        if (selectedPlayerTool === 'undo-player') {
            undoPlayerLastAction();
        } else {
            showMessage(`Selected tool: ${selectedPlayerTool}. Click on the board to place.`);
        }
    });



    const resourceCardButtons = document.querySelectorAll('.resource-card');
    resourceCardButtons.forEach(button => {
        button.addEventListener('click', () => {
            if (selectedHandCards.length > 0) {
                showMessage('Clear your hand selection before taking new resources.');
                return;
            }
            pendingResourceCards.push(button.dataset.resourceType);
            updateResourceSelectionTray('take');
        });
    });

    document.getElementById('clearResourceSelection').addEventListener('click', clearResourceSelection);

    document.getElementById('confirmResourceSelection').addEventListener('click', () => {
        if (document.getElementById('resourceSelectionTray').dataset.mode === 'drop') {
            transferOrDropSelectedCards(PLAYER_ID, 'NA');
        } else {
            commitPendingResourceCards();
        }
    });

    const devCardButton = document.querySelector('.dev-card');
        
    devCardButton.addEventListener('click', async () => {
        const confirmed = await showConfirmation('Do you want to take 1 Development card?');
        
        if (confirmed) {
            if(checkAndDeductCards(PLAYER_ID,'dev',true)){
                if (globalDevCardDeck.length === 0) {
                    initializeDevCardDeck();
                    showMessage('Development card deck was empty, re-initialized and shuffled.');
                }
                if (globalDevCardDeck.length > 0) {
                    const drawnCard = globalDevCardDeck.pop();
                    allPlayersData[PLAYER_ID].devCards.push(drawnCard);
                    socket.emit('card_pick_log', { 
                        pid: PLAYER_ID, 
                        log: "Dev Card"
                    });
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
        if (target.classList.contains('transfer-btn')) {
            const targetPlayerId = target.dataset.targetPlayer;
            if (selectedHandCards.length === 0) {
                const targetPlayerName = allPlayersData[targetPlayerId] ? allPlayersData[targetPlayerId].playerName : targetPlayerId;
                const confirmed = await showConfirmation(`Are you sure you want to steal from ${targetPlayerName}?`);
                if (confirmed) {
                    await stealCards(PLAYER_ID, targetPlayerId);
                } else {
                    showMessage('No stealing done.');
                }
            } else {
                let confirmationMessage = '';
                const targetPlayerName = allPlayersData[targetPlayerId] ? allPlayersData[targetPlayerId].playerName : targetPlayerId;
                confirmationMessage = `Are you sure you want to transfer ${selectedHandCards.length} selected card(s) to ${targetPlayerName}?`;

                const confirmed = await showConfirmation(confirmationMessage);
                if (confirmed) {
                    await transferOrDropSelectedCards(PLAYER_ID, targetPlayerId);
                } else {
                    showMessage('Card transfer/drop cancelled.');
                }
            }

            
        }
    });

    
}

function checkAndDeductCards(playerId, actionType, recordUndo = false) {
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

    if (recordUndo) savePlayerStateToHistory();

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
    console.log("c: w"+containerWidth+"h"+containerHeight);
    const aspectRatio = isPlayerPage && window.matchMedia('(max-width: 768px)').matches ? 0.95 : 1.2;
    let newWidth = containerWidth * mapZoomLevel;
    let newHeight = newWidth / aspectRatio;

    if (newHeight > containerHeight) {
        newHeight = containerHeight;
        newWidth = newHeight * aspectRatio;
    }
    console.log("n: w"+newWidth+"h"+newHeight);
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
        const portExtent = HEX_SIZE * 0.4 + PORT_SIZE;
        minRawX -= portExtent;
        maxRawX += portExtent;
        minRawY -= portExtent;
        maxRawY += portExtent;
        const boardWithPortsWidth = maxRawX - minRawX;
        const boardWithPortsHeight = maxRawY - minRawY;
        const boardPadding = isPlayerPage && window.matchMedia('(max-width: 768px)').matches ? 12 : 48;

        boardScale = Math.min(
            1,
            (canvas.width - boardPadding) / boardWithPortsWidth,
            (canvas.height - boardPadding) / boardWithPortsHeight
        );

        offsetX = (canvas.width / boardScale / 2) - (minRawX + boardWithPortsWidth / 2);
        offsetY = (canvas.height / boardScale / 2) - (minRawY + boardWithPortsHeight / 2);

        boardCenterRawX = minRawX + boardWithPortsWidth / 2;
        boardCenterRawY = minRawY + boardWithPortsHeight / 2;
    } else {
        offsetX = canvas.width / 2;
        offsetY = canvas.height / 2;
        boardCenterRawX = 0;
        boardCenterRawY = 0;
    }

    drawBoard();
}

function updatePlayerUI() {
    calculatepointsandcards();
    if (!isPlayerPage || !allPlayersData[PLAYER_ID]) return;

    const playerNameDisplay = document.getElementById('playerNameDisplay');
    if (window.PLAYER_NAME) allPlayersData[PLAYER_ID].playerName = window.PLAYER_NAME;
    if (playerNameDisplay) playerNameDisplay.textContent = allPlayersData[PLAYER_ID].playerName;

    const handCardsDiv = document.getElementById('handCards');
    if (handCardsDiv) {
        handCardsDiv.innerHTML = '';

        const resourceTypes = ['wood', 'brick', 'sheep', 'hay', 'rock'];
        const resourceCounts = allPlayersData[PLAYER_ID].hand.reduce((counts, resourceType) => {
            counts[resourceType] = (counts[resourceType] || 0) + 1;
            return counts;
        }, {});
        resourceTypes.forEach(resourceType => {
            const count = resourceCounts[resourceType] || 0;
            const cardItem = document.createElement('div');
            cardItem.classList.add('card-item');
            cardItem.classList.add('resource-card'); // Add resource-card class for background image styling
            cardItem.classList.add('animate-in'); // Keep animation
            cardItem.dataset.resourceType = resourceType; // Set data-resource-type for CSS background image
            cardItem.dataset.count = count;
            cardItem.setAttribute('aria-label', `${count} ${resourceType} cards`);
            if (count > 0) {
                cardItem.addEventListener('click', () => toggleCardSelection(cardItem, resourceType));
            } else {
                cardItem.classList.add('hand-resource-empty');
                cardItem.setAttribute('aria-hidden', 'true');
            }

            const countBadge = document.createElement('span');
            countBadge.classList.add('hand-card-count');
            countBadge.textContent = count;
            cardItem.appendChild(countBadge);

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
        renderTransferDropButtons();
        updateUndoButton();
        updateRollButton();
        
}
function updateResourceSelectionTray(mode = 'take') {
    const tray = document.getElementById('resourceSelectionTray');
    const total = document.getElementById('resourceSelectionTotal');
    const details = document.getElementById('resourceSelectionDetails');
    const confirmButton = document.getElementById('confirmResourceSelection');
    const selectedResources = mode === 'drop' ? selectedHandCards : pendingResourceCards;
    const counts = selectedResources.reduce((result, resourceType) => {
        result[resourceType] = (result[resourceType] || 0) + 1;
        return result;
    }, {});

    tray.dataset.mode = mode;
    tray.hidden = selectedResources.length === 0;
    total.textContent = mode === 'drop'
        ? `${selectedResources.length} card${selectedResources.length === 1 ? '' : 's'} staged to drop`
        : `${selectedResources.length} card${selectedResources.length === 1 ? '' : 's'} selected`;
    details.textContent = Object.entries(counts)
        .sort(([first], [second]) => ['wood', 'brick', 'rock', 'sheep', 'hay'].indexOf(first) - ['wood', 'brick', 'rock', 'sheep', 'hay'].indexOf(second))
        .map(([resourceType, count]) => `${count}${({ wood: 'W', brick: 'B', rock: 'R', sheep: 'S', hay: 'H' })[resourceType] || resourceType[0].toUpperCase()}`)
        .join(' ');
    confirmButton.textContent = mode === 'drop' ? 'Drop cards' : 'Take cards';
    confirmButton.classList.toggle('resource-tray-drop', mode === 'drop');
    confirmButton.disabled = selectedResources.length === 0;
    document.querySelectorAll('.player-controls .resource-card').forEach(card => {
        const count = mode === 'take' ? counts[card.dataset.resourceType] || 0 : 0;
        card.classList.toggle('pending-pick', count > 0);
        card.setAttribute('aria-pressed', count > 0 ? 'true' : 'false');
        let badge = card.querySelector('.resource-pick-count');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'resource-pick-count';
            card.appendChild(badge);
        }
        badge.textContent = count;
        badge.hidden = count === 0;
    });
}

function clearResourceSelection() {
    const tray = document.getElementById('resourceSelectionTray');
    const mode = tray.dataset.mode || 'take';
    if (mode === 'drop') {
        selectedHandCards = [];
        document.getElementById('selectedCardCount').textContent = '0';
        document.querySelectorAll('#handCards .resource-card').forEach(card => {
            const count = Number(card.dataset.count || 0);
            card.classList.remove('selected');
            card.classList.toggle('hand-resource-empty', count === 0);
            card.querySelector('.hand-card-count').textContent = count;
            if (count === 0) card.setAttribute('aria-hidden', 'true');
            else card.removeAttribute('aria-hidden');
        });
    } else {
        pendingResourceCards = [];
    }
    updateResourceSelectionTray(mode);
}

async function commitPendingResourceCards() {
    if (pendingResourceCards.length === 0) return;

    const selectedResources = [...pendingResourceCards];
    const counts = selectedResources.reduce((result, resourceType) => {
        result[resourceType] = (result[resourceType] || 0) + 1;
        return result;
    }, {});
    savePlayerStateToHistory();
    allPlayersData[PLAYER_ID].hand.push(...selectedResources);
    pendingResourceCards = [];
    updateResourceSelectionTray('take');
    socket.emit('card_pick_log', {
        pid: PLAYER_ID,
        log: 'resource-pick',
        resources: counts,
        count: selectedResources.length
    });
    await saveAllPlayerStatesToBackend();
    updatePlayerUI();
    showMessage(`Added ${selectedResources.length} card${selectedResources.length === 1 ? '' : 's'} to your hand.`);
}

function toggleCardSelection(cardElement, resourceType) {
    if (pendingResourceCards.length > 0) {
        showMessage('Clear the staged resource picks before selecting hand cards.');
        return;
    }

    const cardCount = Number(cardElement.dataset.count || 0);
    const alreadySelected = selectedHandCards.filter(card => card === resourceType).length;
    if (alreadySelected >= cardCount) return;

    selectedHandCards.push(resourceType);
    const remainingCount = cardCount - alreadySelected - 1;
    cardElement.classList.add('selected');
    cardElement.classList.toggle('hand-resource-empty', remainingCount === 0);
    cardElement.querySelector('.hand-card-count').textContent = remainingCount;
    if (remainingCount === 0) cardElement.setAttribute('aria-hidden', 'true');
    const handCardsDiv = document.getElementById('handCards');
    if (!handCardsDiv) {
        console.warn("Element with ID 'handCards' not found.");
    }
    document.getElementById('selectedCardCount').textContent = selectedHandCards.length;
    updateResourceSelectionTray('drop');
    console.log('Selected cards:', selectedHandCards);
}
async function transferOrDropSelectedCards(currentPlayerId, targetPlayerId) {
    if (selectedHandCards.length === 0) {
        showMessage('No cards selected to transfer/drop.', 'error');
        return;
    }
    const transferredCards = [...selectedHandCards];
    const cardCounts = transferredCards.reduce((counts, resourceType) => {
        counts[resourceType] = (counts[resourceType] || 0) + 1;
        return counts;
    }, {});
    //fix: add code to update counter
    savePlayerStateToHistory(); // Save current state before modification
    selectedHandCards.forEach(item => {
        //console.log('item'+item);
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
    document.getElementById('selectedCardCount').textContent = '0';
    updateResourceSelectionTray('drop');
    const resourceCodes = { wood: 'W', brick: 'B', rock: 'R', sheep: 'S', hay: 'H' };
    const cardSummary = Object.keys(resourceCodes)
        .filter(type => cardCounts[type])
        .map(type => `${cardCounts[type]}${resourceCodes[type]}`)
        .join(' ');
    const actionMessage = targetPlayerId === 'NA'
        ? `dropped ${cardSummary} (${transferredCards.length})`
        : `gave ${cardSummary} (${transferredCards.length}) to ${allPlayersData[targetPlayerId].playerName}`;
    socket.emit('game_action_log', { pid: currentPlayerId, message: actionMessage });
    await saveAllPlayerStatesToBackend(); // Save changes to backend
    updatePlayerUI(); 
    showMessage('Card operation completed.');
}
async function stealCards(currentPlayerId, targetPlayerId) {
    savePlayerStateToHistory(); // Save current state before modification
    targetHandCards = allPlayersData[targetPlayerId].hand;
    let stolenCard = null;
    if (targetHandCards.length > 0) {
        const randomIndex = Math.floor(Math.random() * targetHandCards.length);
        stolenCard = targetHandCards[randomIndex];
        allPlayersData[targetPlayerId].hand.splice(randomIndex, 1);
        allPlayersData[currentPlayerId].hand.push(stolenCard);
    }
    
    await saveAllPlayerStatesToBackend(); // Save changes to backend
    if (stolenCard) {
        socket.emit('game_action_log', {
            pid: currentPlayerId,
            message: `stole 1 ${stolenCard} from ${allPlayersData[targetPlayerId].playerName}`
        });
    }
    updatePlayerUI(); 
    showMessage('Card steal completed.');
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

/**
 * Rolls two dice 
 */
function getRandomInt(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getDicePipHTML(value) {
    const pipPositions = {
        1: [4],
        2: [0, 8],
        3: [0, 4, 8],
        4: [0, 2, 6, 8],
        5: [0, 2, 4, 6, 8],
        6: [0, 2, 3, 5, 6, 8]
    };
    const pips = (pipPositions[value] || []).map(position => {
        const row = Math.floor(position / 3) + 1;
        const column = position % 3 + 1;
        return `<span class="die-pip" style="grid-area: ${row} / ${column}"></span>`;
    }).join('');
    return pips;
}

function getDiceFaceHTML(value) {
    return `<div class="dice-face" role="img" aria-label="Die showing ${value}">${getDicePipHTML(value)}</div>`;
}

function setDiceFaceValue(face, value) {
    face.setAttribute('aria-label', `Die showing ${value}`);
    face.innerHTML = getDicePipHTML(value);
}

function renderGameDiceResult(dice) {
    const displayElement = document.getElementById('diceroll');
    if (!displayElement) return;
    displayElement.innerHTML = `<div class="dice-result" aria-live="polite">${getDiceFaceHTML(dice[0])}${getDiceFaceHTML(dice[1])}</div>`;
    displayElement.classList.remove('rolling');
    displayElement.classList.add('final-roll');
}

function getDiceRollOverlay() {
    let overlay = document.getElementById('diceRollOverlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'diceRollOverlay';
    overlay.className = 'dice-roll-overlay';
    overlay.hidden = true;
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.setAttribute('tabindex', '0');
    overlay.title = 'Click to dismiss the dice result';
    overlay.innerHTML = '<div class="dice-roll-panel"><span class="dice-roll-caption">Rolling dice</span><div class="dice-overlay-pair"><div class="dice-face" role="img" aria-label="Die"></div><div class="dice-face" role="img" aria-label="Die"></div></div></div>';
    overlay.addEventListener('click', dismissDiceRollOverlay);
    overlay.addEventListener('keydown', event => {
        if (event.key === 'Escape' && overlay.classList.contains('is-result')) {
            dismissDiceRollOverlay();
        }
    });
    document.body.appendChild(overlay);
    return overlay;
}

function dismissDiceRollOverlay() {
    const overlay = document.getElementById('diceRollOverlay');
    if (!overlay || !overlay.classList.contains('is-result')) return;
    if (diceOverlayHideTimeout) window.clearTimeout(diceOverlayHideTimeout);
    diceOverlayHideTimeout = null;
    overlay.classList.remove('is-visible', 'is-result');
    overlay.hidden = true;
}

function showSharedDiceRoll(finalDice) {
    if (diceAnimationInterval) window.clearInterval(diceAnimationInterval);
    if (diceAnimationTimeout) window.clearTimeout(diceAnimationTimeout);
    if (diceOverlayHideTimeout) window.clearTimeout(diceOverlayHideTimeout);

    const overlay = getDiceRollOverlay();
    const faces = overlay.querySelectorAll('.dice-face');
    const caption = overlay.querySelector('.dice-roll-caption');
    overlay.hidden = false;
    overlay.classList.remove('is-result');
    overlay.classList.add('is-visible', 'is-rolling');
    caption.textContent = 'Rolling dice';

    const randomizeFaces = () => {
        faces.forEach(face => setDiceFaceValue(face, getRandomInt(1, 6)));
    };
    randomizeFaces();
    diceAnimationInterval = window.setInterval(randomizeFaces, 115);

    diceAnimationTimeout = window.setTimeout(() => {
        window.clearInterval(diceAnimationInterval);
        diceAnimationInterval = null;
        faces.forEach((face, index) => setDiceFaceValue(face, finalDice[index]));
        caption.textContent = 'Dice result · click to dismiss';
        overlay.classList.remove('is-rolling');
        overlay.classList.add('is-result');

        renderGameDiceResult(finalDice);

        diceOverlayHideTimeout = window.setTimeout(() => {
            overlay.classList.remove('is-visible', 'is-result');
            overlay.hidden = true;
        }, 5000);
    }, 1500);
}


function rolldice()
{
    if (!isPlayerPage || allPlayersData._currentTurnPlayerId !== PLAYER_ID) {
        updateRollButton();
        return;
    }
    socket.emit('roll_dice', { player_id: PLAYER_ID });

}
socket.on('undo_history_reset', () => {
    allPlayersData._undoStack = [];
    updateUndoButton();
});

socket.on('board_edit_state', data => {
    boardEditingAllowed = data?.editable === true;
    if (boardEditingAllowed && builderHistoryStack.length === 0) saveBuilderState();
    if (!boardEditingAllowed) builderHistoryStack = [];
    updateBoardEditingUI();
});

socket.on('roll_rejected', data => {
    if (data.current_player) allPlayersData._currentTurnPlayerId = data.current_player;
    updateRollButton();
    showMessage(data.message || 'It is not your turn to roll.', 'error');
});

socket.on('roll_dice_broadcast', (data) => {
    const dice = Array.isArray(data?.dice) && data.dice.length === 2
        && data.dice.every(value => Number.isInteger(value) && value >= 1 && value <= 6)
        ? data.dice
        : [getRandomInt(1, 6), getRandomInt(1, 6)];
    if (data.next_player) allPlayersData._currentTurnPlayerId = data.next_player;
    updateRollButton();
    showSharedDiceRoll(dice);
});


function updateLargestArmyHolder() {
    const playerIds = Object.keys(allPlayersData).filter(playerId => playerId.startsWith('player'));
    const knightCounts = playerIds.map(playerId => Number(allPlayersData[playerId].knightplayed) || 0);
    const highestCount = Math.max(0, ...knightCounts);
    const currentHolder = playerIds.find(playerId => allPlayersData[playerId].largestarmy);
    if (currentHolder) {
        if (allPlayersData[currentHolder].largestarmymanual) return;
        const holderCount = Number(allPlayersData[currentHolder].knightplayed) || 0;
        if (holderCount >= 3 && highestCount <= holderCount) return;
        if (holderCount < 3) {
            playerIds.forEach(playerId => {
                allPlayersData[playerId].largestarmy = 0;
                allPlayersData[playerId].largestarmymanual = 0;
            });
        }
    }
    if (highestCount < 3) return;

    const leaders = playerIds.filter(playerId => (Number(allPlayersData[playerId].knightplayed) || 0) === highestCount);
    if (leaders.length !== 1) return;

    playerIds.forEach(playerId => {
        allPlayersData[playerId].largestarmy = playerId === leaders[0] ? 1 : 0;
        allPlayersData[playerId].largestarmymanual = 0;
    });
}

async function playdevcard(currentPlayerId, item) {
    const confirmed = await showConfirmation(`Are you sure you want to play the ${item} card?`);
    if (confirmed) {
        savePlayerStateToHistory(); // Save state before playing
        const index = allPlayersData[currentPlayerId].devCards.indexOf(item);
        if (index > -1) {
            allPlayersData[currentPlayerId].devCards.splice(index, 1); 
        }
            
        
        if(item === "knight")
        {
            allPlayersData[currentPlayerId].knightplayed +=1;
            updateLargestArmyHolder();
        }else if (item === "victory_point")
        {
            allPlayersData[currentPlayerId].victory_point +=1;
        }
        await saveAllPlayerStatesToBackend(); // Save changes to backend
        updatePlayerUI(); // Update UI immediately
        
        } else {
            showMessage('Error: Could not find the specific card to play.', 'error');
        }
        socket.emit('dev_card_played', { 
            cardType: item, 
            playerName: allPlayersData[currentPlayerId].playerName 
        });
}
function renderGameScoreboard() {
    if (!isGamePage) return;

    const seatPlayerIds = ['player1', 'player2', 'player3', 'player4'];
    const registeredOrder = Array.isArray(allPlayersData._turnOrder)
        ? allPlayersData._turnOrder.filter(playerId => seatPlayerIds.includes(playerId))
        : [];
    const playerIds = [...new Set([...registeredOrder, ...seatPlayerIds])];
    const longestRoadOwner = seatPlayerIds.find(playerId => allPlayersData[playerId].longestroad) || '';
    const largestArmyOwner = seatPlayerIds.find(playerId => allPlayersData[playerId].largestarmy) || '';
    const longestRoadDropdown = document.getElementById('pl-dropdown');
    const largestArmyDropdown = document.getElementById('la-dropdown');
    const scoreboardBody = document.querySelector('#assignpoint table tbody');

    playerIds.forEach(playerId => {
        const player = allPlayersData[playerId];
        const row = scoreboardBody.querySelector(`[data-player-id="${playerId}"]`);
        if (!row) return;

        row.cells[0].textContent = player.playerName;
        row.cells[1].textContent = player.score;
        row.cells[2].textContent = player.hand.length;
        row.cells[3].textContent = Number(player.knightplayed) || 0;
        row.cells[4].textContent = player.devCards.length;
        scoreboardBody.appendChild(row);

        const longestRoadOption = longestRoadDropdown.querySelector(`option[value="${playerId}"]`);
        const largestArmyOption = largestArmyDropdown.querySelector(`option[value="${playerId}"]`);
        if (longestRoadOption) longestRoadOption.textContent = player.playerName;
        if (largestArmyOption) largestArmyOption.textContent = player.playerName;
    });

    longestRoadDropdown.value = longestRoadOwner;
    largestArmyDropdown.value = largestArmyOwner;
}

function calculatepointsandcards() {
    for (const playerId in allPlayersData) {
        if (!playerId.startsWith('player')) continue;

        const player = allPlayersData[playerId];
        let score = (player.largestarmy ? 2 : 0) + (player.longestroad ? 2 : 0);
        const structurePoints = new Map();
        for (const structure of player.structures || []) {
            const points = structure.type === 'city' ? 2 : structure.type === 'house' ? 1 : 0;
            if (points === 0) continue;
            const junctionId = structure.junction.id;
            structurePoints.set(junctionId, Math.max(structurePoints.get(junctionId) || 0, points));
        }
        score += [...structurePoints.values()].reduce((total, points) => total + points, 0);
        score += Number(player.victory_point) || 0;
        score += (player.devCards || []).filter(card => card === 'victory_point').length;
        player.score = score;
    }

    renderGameScoreboard();
    socket.emit('score_update');
}
function handleDropdownChange() {
        const dropdown = document.getElementById('pl-dropdown');
        const selectedValue = dropdown.value;
        ['player1', 'player2', 'player3', 'player4'].forEach(playerId => {
            allPlayersData[playerId].longestroad = playerId === selectedValue ? 1 : 0;
            allPlayersData[playerId].longestroadmanual = playerId === selectedValue ? 1 : 0;
        });
        calculatepointsandcards();
        saveAllPlayerStatesToBackend(true);
    }

function handleLargestArmyChange() {
    const selectedValue = document.getElementById('la-dropdown').value;
    ['player1', 'player2', 'player3', 'player4'].forEach(playerId => {
        allPlayersData[playerId].largestarmy = playerId === selectedValue ? 1 : 0;
        allPlayersData[playerId].largestarmymanual = playerId === selectedValue ? 1 : 0;
    });
    calculatepointsandcards();
    saveAllPlayerStatesToBackend(true);
}
async function onCatanPlayerPageLoad() {
    await loadAllStatesFromBackend();
    const registeredName = window.PLAYER_NAME;
    if (registeredName && allPlayersData[PLAYER_ID].playerName !== registeredName) {
        allPlayersData[PLAYER_ID].playerName = registeredName;
        await saveAllPlayerStatesToBackend();
    }
    updatePlayerUI();
}

socket.on('catan_update', async () => {
    console.log('Received catan_update from server. Reloading state...');
    // Reload all states from the backend and update the UI
    await loadAllStatesFromBackend();
    updatePlayerUI();
    if (!isGamePage) showMessage('Game state updated by another player!');

    
});

socket.on('dev_card_played_broadcast', (data) => {
    //add code here for updating the counter
    if (isGamePage) {
        const playedCardsContainer = document.getElementById('devCards');
        playedCardsContainer.innerHTML='';
        if (playedCardsContainer) {
            const cardElement = document.createElement('div');
            cardElement.classList.add('card-item');
            cardElement.classList.add('dev-card'); 
            cardElement.classList.add('animate-in'); 
            //cardElement.dataset.resourceType = data.cardType; // For background image
            cardElement.dataset.cardType = data.cardType;
            const cardHdr = document.createElement('h3');
            cardHdr.innerHTML = `
                ${data.playerName} Played:
            `;
            playedCardsContainer.appendChild(cardHdr);
            playedCardsContainer.appendChild(cardElement);
            const playerName = data.playerName ? data.playerName[0].toUpperCase() + data.playerName.slice(1) : 'A player';
            const cardName = data.cardType.replaceAll('_', ' ');
            showMessage(`${playerName} played ${cardName}`);
        }
    }
});

socket.on('score_update_broadcast', () => {
    renderGameScoreboard();
});

socket.on('card_pick_log_broadcast', (data) => {
    if (isGamePage) {
        const playedCardsContainerh = document.getElementById(data.pid+'logh');
        const playedCardsContainer = document.getElementById(data.pid+'log');
        const playerName = allPlayersData[data.pid]?.playerName || data.pid;
        const log = String(data.log || '');
        const displayName = playerName ? playerName[0].toUpperCase() + playerName.slice(1) : data.pid;
        const resourceCodes = { wood: 'W', brick: 'B', rock: 'R', sheep: 'S', hay: 'H' };
        let resources = data.resources;
        if (!resources && log.startsWith('Took ')) {
            resources = {};
            for (const match of log.matchAll(/(wood|brick|rock|sheep|hay)\s*x\s*(\d+)/gi)) {
                resources[match[1].toLowerCase()] = Number(match[2]);
            }
        }

        if (resources && Object.keys(resources).length) {
            const summary = Object.keys(resourceCodes)
                .filter(type => Number(resources[type]) > 0)
                .map(type => `${Number(resources[type])}${resourceCodes[type]}`)
                .join(' ');
            const total = Number(data.count) || Object.values(resources).reduce((sum, count) => sum + (Number(count) || 0), 0);
            showMessage(`${displayName} picked ${summary} (${total})`);
        } else if (log === 'Dev Card') {
            showMessage(`${displayName} picked Dev (1)`);
        } else {
            showMessage(`${displayName} picked ${resourceCodes[log.toLowerCase()] || log} (1)`);
        }
        if (playedCardsContainer) {
            playedCardsContainerh.innerHTML = playerName;
            addDisappearingTag(playedCardsContainer,data.log);
            
        }
    }
});

socket.on('game_action_log_broadcast', (data) => {
    if (!isGamePage) return;
    const playerName = allPlayersData[data.pid]?.playerName || data.pid;
    showMessage(`${playerName} ${data.message}.`);
});

window.addEventListener('load', async () => {
    if (!isGamePage && !isPlayerPage) updateBoardEditingUI();
    await preloadImages();
    if (!isGamePage && !isPlayerPage) {
        saveBuilderState();
    } else if (isPlayerPage) {
        onCatanPlayerPageLoad();
    }
});
window.addEventListener('resize', resizeCanvas);
