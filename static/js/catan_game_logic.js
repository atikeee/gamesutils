const canvas = document.getElementById('catanBoard');
const ctx = canvas.getContext('2d');
const messageBox = document.getElementById('messageBox');
let messageTimeout = null;
messageBox?.addEventListener('click', () => {
    window.clearTimeout(messageTimeout);
    messageBox.textContent = '';
});

const isGamePage = window.location.pathname === '/catan/game';
const isPlayerPage = window.location.pathname.startsWith('/catan/player/');

const PLAYER_ID = isPlayerPage && window.PLAYER_ID ? 'player' + window.PLAYER_ID : null;


let loadedResourceImages = {};
let boardTiles = [];
let boardEditingAllowed = document.body.dataset.boardEditable === 'true';
let gameRobberMoveSelected = false;
let gameRobberMoveSaving = false;
let mapZoomLevel = 1;
let selectedHandCards  = [];
let cardActionPending = false;
let pendingResourceCards = [];
let diceAnimationInterval = null;
let diceAnimationTimeout = null;
let diceOverlayHideTimeout = null;
let wasMyTurn = false;
const playerSounds = isPlayerPage ? {
    roll: new Audio('/catan/audio/rolldice.mp3'),
    //danger: new Audio('/catan/audio/dice7.mp3'),
    turn: new Audio('/catan/audio/yourturn.mp3'),
    victory: new Audio('/catan/audio/victorypoint.mp3')
} : null;

const socket = io();
let init_player_data = {
    'player1': { playerName: 'Player 1', hand: [], devCards: [], roads: [], structures: [], history: [],longestroad: 0,largestarmy:0,knightplayed:0,merchant:0,victory_point:0,score:0 },
    'player2': { playerName: 'Player 2', hand: [], devCards: [], roads: [], structures: [], history: [],longestroad: 0,largestarmy:0,knightplayed:0,merchant:0,victory_point:0,score:0 },
    'player3': { playerName: 'Player 3', hand: [], devCards: [], roads: [], structures: [], history: [],longestroad: 0,largestarmy:0,knightplayed:0,merchant:0,victory_point:0,score:0 },
    'player4': { playerName: 'Player 4', hand: [], devCards: [], roads: [], structures: [], history: [],longestroad: 0,largestarmy:0,knightplayed:0,merchant:0,victory_point:0,score:0 },
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
let lastTurnNotice = null;

let offsetX = 0;
let offsetY = 0;
let boardScale = 1;

let boardCenterRawX = 0;
let boardCenterRawY = 0;

let selectedTool = null;
let boardControlsEnabled = false;
let selectedSwapItem1 = null;
let selectedSwapItem2 = null;
let builderHistoryStack = [];

let selectedPlayerTool = null;
let selectedRoadStartJunction = null;

function clearSelectedPlayerTool() {
    selectedPlayerTool = null;
    document.querySelectorAll('#player-tool-select .btn-tool.selected').forEach(button => button.classList.remove('selected'));
}

let allJunctions = [];
let allEdges = [];

const confirmationModal = document.getElementById('confirmationModal');
const modalMessage = document.getElementById('modalMessage');
const modalConfirmBtn = document.getElementById('modalConfirmBtn');
const modalCancelBtn = document.getElementById('modalCancelBtn');
let modalResolve;

const mapZoomToggle = document.getElementById('mapZoomToggle');
function setMapZoom(level) {
    mapZoomLevel = level;
    const zoomViewport = document.querySelector('.map-zoom-viewport');
    zoomViewport.classList.toggle('map-zoomed', mapZoomLevel === 2);
    mapZoomToggle.setAttribute('aria-pressed', String(mapZoomLevel === 2));
    const icon = mapZoomToggle.querySelector('i');
    if (icon) icon.className = `fas ${mapZoomLevel === 2 ? 'fa-magnifying-glass-minus' : 'fa-magnifying-glass-plus'}`;
    else mapZoomToggle.textContent = mapZoomLevel === 2 ? '\u2212' : '+';
    mapZoomToggle.title = mapZoomLevel === 2 ? 'Zoom out' : 'Zoom in';
    mapZoomToggle.setAttribute('aria-label', mapZoomToggle.title);
    resizeCanvas();
    zoomViewport.scrollLeft = 0;
    zoomViewport.scrollTop = 0;
}
if (mapZoomToggle) {
    mapZoomToggle.addEventListener('click', () => setMapZoom(mapZoomLevel === 1 ? 2 : 1));
}

const boardControlsToggle = document.getElementById('boardControlsToggle');
if (boardControlsToggle) {
    boardControlsToggle.addEventListener('click', () => {
        boardControlsEnabled = !boardControlsEnabled;
        boardControlsToggle.setAttribute('aria-pressed', String(boardControlsEnabled));
        boardControlsToggle.querySelector('i').className = `fas ${boardControlsEnabled ? 'fa-eye' : 'fa-eye-slash'}`;
        boardControlsToggle.title = boardControlsEnabled ? 'Disable map controls' : 'Enable map controls';
        boardControlsToggle.setAttribute('aria-label', boardControlsToggle.title);
        if (!boardControlsEnabled && mapZoomLevel !== 1) setMapZoom(1);
        updateBoardEditingUI();
        drawBoard();
    });
}

const startGameButton = document.getElementById('startCatanGame');
if (startGameButton) {
    startGameButton.addEventListener('click', async () => {
        startGameButton.disabled = true;
        try {
            const response = await fetch('/catan/start_game', { method: 'POST' });
            const result = await response.json();
            if (!response.ok) throw new Error(result.message || 'Could not start the game.');
            if (isPlayerPage) startGameButton.hidden = true;
            else startGameButton.textContent = 'Started';
        } catch (error) {
            startGameButton.disabled = false;
            startGameButton.title = error.message;
            startGameButton.textContent = 'Retry start';
        }
    });
}

function showMessage(message, type = 'info') {
    if (message === 'Game state updated by another player!' || message === 'All player states loaded successfully!') return;
    if (isGamePage) {
        if (!boardControlsEnabled || !messageBox) return;
        const toast = document.createElement('div');
        toast.className = `game-toast${type === 'error' ? ' game-toast-error' : ''}`;
        toast.textContent = message;
        messageBox.replaceChildren(toast);
        window.clearTimeout(messageTimeout);
        messageTimeout = window.setTimeout(() => messageBox.replaceChildren(), 3000);
        return;
    }

    messageBox.textContent = message;
    messageBox.className = `message-box ${type === 'error' ? 'bg-red-100 text-red-800 border-red-300' : 'bg-yellow-100 text-yellow-800 border-orange-300'}`;
    if (isPlayerPage) {
        window.clearTimeout(messageTimeout);
        messageTimeout = window.setTimeout(() => {
            messageBox.textContent = '';
            messageTimeout = null;
        }, 3000);
    }
}

function playPlayerSound(kind) {
    const sound = playerSounds?.[kind];
    if (!sound) return;
    sound.currentTime = 0;
    void sound.play().catch(() => {});
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

function confirmReset() {
    const dialog = document.getElementById('resetDialog');
    return new Promise(resolve => {
        dialog.returnValue = '';
        dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
        dialog.onclick = event => { if (event.target === dialog) dialog.close(); };
        dialog.showModal();
    });
}

function chooseOption(title, options) {
    const modal = document.getElementById('choiceModal');
    if (!modal) return Promise.resolve(null);
    document.getElementById('choiceTitle').textContent = title;
    const buttons = document.getElementById('choiceButtons');
    buttons.replaceChildren();
    return new Promise(resolve => {
        modal.onclick = event => {
            if (event.target === modal) {
                modal.classList.add('hidden');
                resolve(null);
            }
        };
        options.forEach(({ value, label, image }) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn btn-tool';
            if (image) {
                const artwork = document.createElement('img');
                artwork.src = image;
                artwork.alt = '';
                artwork.width = 44;
                button.appendChild(artwork);
            }
            button.append(label);
            button.addEventListener('click', () => { modal.classList.add('hidden'); resolve(value); });
            buttons.appendChild(button);
        });
        modal.classList.remove('hidden');
    });
}

function choosePlayer(ids) {
    return chooseOption('Steal a random card from:', ids.map(value => ({ value, label: allPlayersData[value].playerName })));
}

function chooseResource() {
    return chooseOption('Choose a resource for Monopoly', ['wood', 'brick', 'sheep', 'hay', 'rock'].map(value => ({ value, label: value, image: resourceImagePaths[value] })));
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
    return Promise.all(Object.entries(resourceImagePaths).map(([type, path]) => new Promise(resolve => {
        const image = new Image();
        image.onload = () => { loadedResourceImages[type] = image; resolve(); };
        image.onerror = () => { loadedResourceImages[type] = null; resolve(); };
        image.src = path;
    })));
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
                    drawRoad(ctx, road.edge, window.CATAN_PLAYER_COLORS?.[road.owner] || PLAYER_COLORS[road.owner], offsetX, offsetY);
                });
                playerData.structures.forEach(structure => {
                    const ownerColor = window.CATAN_PLAYER_COLORS?.[structure.owner] || PLAYER_COLORS[structure.owner];
                    if (structure.type === 'house') {
                        drawHouse(ctx, structure.junction, ownerColor, offsetX, offsetY);
                    } else if (structure.type === 'city') {
                        drawCity(ctx, structure.junction, ownerColor, offsetX, offsetY);
                    }
                });
            }
        }
    }

    if (allPlayersData['robber'] && allPlayersData['robber'].q !== 100) {
        drawRobber(ctx, allPlayersData['robber'], offsetX, offsetY);
        if (gameRobberMoveSelected || (allPlayersData._robberPending && isPlayerPage && allPlayersData._currentTurnPlayerId === PLAYER_ID)) {
            const pixel = hexToPixel(allPlayersData.robber.q, allPlayersData.robber.r, offsetX, offsetY);
            ctx.strokeStyle = '#facc15';
            ctx.lineWidth = 5;
            ctx.beginPath();
            ctx.arc(pixel.x, pixel.y, TILE_RADIUS / 2, 0, Math.PI * 2);
            ctx.stroke();
        }
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

    if (isGamePage) {
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
    if (!isGamePage || !boardEditingAllowed) return;

    builderHistoryStack.push({
        tileStates: JSON.parse(JSON.stringify(boardTiles.map(tile => ({ q: tile.q, r: tile.r, type: tile.type, number: tile.number })))),
        robber: allPlayersData['robber'] ? JSON.parse(JSON.stringify(allPlayersData['robber'])) : null,
    });
}

function updateBoardEditingUI() {
    if (!isGamePage) return;
    if (!boardControlsEnabled || !boardEditingAllowed) {
        selectedTool = null;
        selectedSwapItem1 = null;
        selectedSwapItem2 = null;
    }
    document.querySelectorAll('#boardTools .map-tool').forEach(button => {
        const editsBoard = ['swap', 'shuffle-cells', 'shuffle-numbers', 'undo'].includes(button.dataset.tool);
        button.disabled = !boardControlsEnabled || (editsBoard && !boardEditingAllowed);
        if (editsBoard && !boardEditingAllowed) button.title = 'Reset the game to edit the board';
        else if (button.dataset.label) button.title = button.dataset.label;
    });
    const swapButton = document.querySelector('#boardTools [data-tool="swap"]');
    if (swapButton) {
        swapButton.classList.toggle('selected', selectedTool === 'swap');
        swapButton.setAttribute('aria-pressed', String(selectedTool === 'swap'));
    }
}

function undoBuilderLastAction() {
    if (!isGamePage) return;
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
    const button = document.querySelector('.player-map-shell [data-tool="undo-player"]');
    if (!button) return;
    const undoCount = Array.isArray(allPlayersData._undoStack) ? allPlayersData._undoStack.length : 0;
    button.disabled = undoCount === 0;
    button.title = undoCount > 0 ? `Undo last action (${undoCount} available)` : 'Undo unavailable';
    button.setAttribute('aria-disabled', String(undoCount === 0));
}

function updateRollButton() {
    const button = document.getElementById('turnButton');
    if (!button) return;

    const lastRollTotal = document.getElementById('lastRollTotal');
    if (lastRollTotal) {
        const dice = allPlayersData._lastRoll?.dice;
        const total = Array.isArray(dice) && dice.length === 2 && dice.every(value => Number.isInteger(value) && value >= 1 && value <= 6)
            ? dice[0] + dice[1] : null;
        lastRollTotal.hidden = total === null;
        lastRollTotal.textContent = total === null ? '' : String(total);
        lastRollTotal.setAttribute('aria-label', total === null ? 'No roll yet' : `Last roll total: ${total}`);
    }

    const currentPlayerId = allPlayersData._currentTurnPlayerId;
    const currentPlayerName = allPlayersData[currentPlayerId]?.playerName || 'the next player';
    const isMyTurn = isPlayerPage && currentPlayerId === PLAYER_ID;
    const state = !allPlayersData._started || !isMyTurn ? 'waiting' : allPlayersData._phase !== 'MAIN_PHASE' ? 'setup' : allPlayersData._rolled ? 'end' : 'roll';
    button.dataset.state = state;
    button.querySelector('i').className = `fas ${state === 'end' ? 'fa-check' : state === 'roll' ? 'fa-dice' : state === 'setup' ? 'fa-flag' : 'fa-xmark'}`;
    button.disabled = state !== 'roll' && state !== 'end';
    button.title = !allPlayersData._started ? 'Waiting for game to start' : state === 'waiting' ? `Not your turn. Waiting for ${currentPlayerName}` : state === 'setup' ? 'Place a settlement and connected road' : state === 'roll' ? 'Roll dice' : 'End turn';
    button.setAttribute('aria-label', button.title);
    document.querySelectorAll('#player-tool-select [data-tool]').forEach(control => {
        if (control.dataset.tool !== 'undo-player') control.disabled = !allPlayersData._started || currentPlayerId !== PLAYER_ID || (allPlayersData._phase === 'START_PHASE' && !['house', 'road'].includes(control.dataset.tool));
    });
}

async function undoPlayerLastAction() {
    const undoStack = Array.isArray(allPlayersData._undoStack) ? allPlayersData._undoStack : [];
    if (!isPlayerPage || undoStack.length === 0) {
        updateUndoButton();
        return;
    }

    const snapshot = undoStack.pop();
    allPlayersData = JSON.parse(JSON.stringify(snapshot.state));
    allPlayersData._undoStack = undoStack;
    globalDevCardDeck = [...(snapshot.devCardDeck || [])];
    selectedHandCards = [];
    pendingResourceCards = [];
    clearSelectedPlayerTool();
    const selectedCardCount = document.getElementById('selectedCardCount');
    if (selectedCardCount) selectedCardCount.textContent = '0';
    updateLargestArmyHolder();
    updateLongestRoadHolder();
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
    if (!isGamePage) return;
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

    nonDesertTiles.forEach((tile, index) => {
        tile.type = assignments[index];
    });
    saveBuilderState();

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
    if (!isGamePage) return;
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

    nonDesertTiles.forEach((tile, index) => {
        tile.number = assignments[index];
    });
    saveBuilderState();
    showMessage('Numbers shuffled with adjacent repeats avoided.');
    drawBoard();
    saveBoardTilesToBackend();
}

async function saveBoardTilesToBackend() {
    if (!isGamePage || !boardEditingAllowed) {
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
            if (builderHistoryStack.length === 0) saveBuilderState();
        } else {
            if (!isPlayerPage) showMessage((result.message || "No saved board tiles found.") + ' Displaying default board tiles.', 'info');
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
            if (builderHistoryStack.length === 0) saveBuilderState();
        }
        allJunctions = getAllJunctions();
        allEdges = getAllEdges();
        resizeCanvas();
    } catch (e) {
        boardEditingAllowed = false;
        updateBoardEditingUI();
        if (!isPlayerPage) showMessage('Network error loading board tiles: ' + e.message + '. Displaying default board tiles.', 'error');
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
                return true;
            } else {
                console.error('Error saving all player states:', result.message);
                if (!isPlayerPage) showMessage('Error saving all player states: ' + result.message, 'error');
                await loadAllPlayerStatesFromBackend();
                updatePlayerUI();
                return false;
            }
        } catch (e) {
            console.error('Network error saving all player states:', e);
            if (!isPlayerPage) showMessage('Network error saving all player states: ' + e.message, 'error');
            await loadAllPlayerStatesFromBackend();
            updatePlayerUI();
            return false;
        }
    }
    // The server broadcasts after the state has been persisted.

    
    
    
}

async function loadAllPlayerStatesFromBackend() {
    try {
        const response = await fetch('/catan/load_play_state');
        
        const result = await response.json();
        if (result.status === 'success' && result.play_state) {
            const loadedStates = result.play_state;
            if (result.player_colors) window.CATAN_PLAYER_COLORS = result.player_colors;
            allPlayersData._started = Boolean(loadedStates._started);
            if (isPlayerPage) {
                document.querySelectorAll('.player-color-option').forEach(option => {
                    const input = option.querySelector('input[name="color"]');
                    const claimed = (result.claimed_colors || []).includes(input.value);
                    input.disabled = claimed || allPlayersData._started;
                    option.classList.toggle('unavailable', input.disabled);
                    option.querySelector('.player-color-status').textContent = claimed ? ' (taken)' : '';
                });
            }
            if (startGameButton) {
                startGameButton.disabled = Boolean(loadedStates._started);
                if (isPlayerPage) startGameButton.hidden = allPlayersData._started || !document.body.classList.contains('has-player-color');
                else startGameButton.textContent = loadedStates._started ? 'Started' : 'Start game';
            }
            if (isPlayerPage && loadedStates._started && !document.body.classList.contains('has-player-color')) {
                const assignedColor = result.player_colors?.[PLAYER_ID];
                if (assignedColor) {
                    document.body.classList.add('has-player-color');
                    document.body.style.setProperty('--player-color', assignedColor);
                    document.body.style.setProperty('--player-color-text', assignedColor === '#F1C40F' ? '#1a1a1a' : '#ffffff');
                    const picker = document.querySelector('.player-color-picker');
                    if (picker) picker.hidden = true;
                }
            }
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
            if (allPlayersData.robber.q === 100) allPlayersData.robber = boardTiles.find(tile => tile.type === 'desert') || allPlayersData.robber;
            allPlayersData._phase = loadedStates._phase || 'MAIN_PHASE';
            allPlayersData._setupIndex = loadedStates._setupIndex || 0;
            allPlayersData._rolled = Boolean(loadedStates._rolled);
            allPlayersData._lastRoll = loadedStates._lastRoll;
            allPlayersData._pendingDiscards = loadedStates._pendingDiscards || {};
            allPlayersData._robberPending = Boolean(loadedStates._robberPending);
            globalDevCardDeck = loadedStates._devDeck || [];
            allPlayersData._devDeckInitialized = Boolean(loadedStates._devDeckInitialized);
            allPlayersData._freeRoads = loadedStates._freeRoads || 0;
            if (isGamePage && loadedStates._lastRoll) renderGameDiceResult(loadedStates._lastRoll.dice, allPlayersData[loadedStates._lastRoll.player]?.playerName);
            const deckCount = document.getElementById('devDeckCount');
            if (deckCount) deckCount.textContent = loadedStates._devDeck?.length ?? 25;
            if (isGamePage) {
                renderActivity(loadedStates._activityLog || []);
                renderLastPlayedDevCard((loadedStates._activityLog || []).slice().reverse().find(entry => entry.action === 'played' && entry.cardType));
            }
            allPlayersData._undoStack = Array.isArray(loadedStates._undoStack) ? loadedStates._undoStack.slice(-3) : [];
            allPlayersData._turnOrder = Array.isArray(loadedStates._turnOrder) ? loadedStates._turnOrder : [];
            allPlayersData._currentTurnPlayerId = loadedStates._currentTurnPlayerId || allPlayersData._turnOrder[0] || null;
            if (isPlayerPage && allPlayersData._currentTurnPlayerId !== PLAYER_ID) clearSelectedPlayerTool();
            const isMyTurn = isPlayerPage && allPlayersData._started && allPlayersData._currentTurnPlayerId === PLAYER_ID;
            if (isMyTurn && !wasMyTurn) void playPlayerSound('turn');
            wasMyTurn = isMyTurn;
            if (isPlayerPage && allPlayersData._started && allPlayersData._currentTurnPlayerId === PLAYER_ID) {
                const notice = `${allPlayersData._phase}:${allPlayersData._setupIndex}:${allPlayersData._rolled}`;
                if (notice !== lastTurnNotice && (allPlayersData._phase === 'START_PHASE' || !allPlayersData._rolled)) {
                    showMessage(allPlayersData._phase === 'START_PHASE' ? "It's your turn to place 1 free Settlement and 1 connected free Road." : "It's your turn!");
                    lastTurnNotice = notice;
                }
            }
            const required = allPlayersData._pendingDiscards[PLAYER_ID];
            if (isPlayerPage && required && lastTurnNotice !== `discard:${required}`) {
                lastTurnNotice = `discard:${required}`;
                const counts = Object.entries(allPlayersData._pendingDiscards).map(([playerId, count]) => `${allPlayersData[playerId].playerName}: ${count}`).join(', ');
                chooseOption(`Drop cards: ${counts}`, [{ value: 'select', label: 'OK' }]);
            }
        } else {
            if (!isPlayerPage) showMessage("No saved player states found. Initializing default player states.", 'info');
            allPlayersData = init_player_data;
            allPlayersData._undoStack = [];
            allPlayersData._turnOrder = [];
            allPlayersData._currentTurnPlayerId = null;
        }
        drawBoard();
    } catch (e) {
        if (!isPlayerPage) showMessage('Network error loading player states: ' + e.message + '. Initializing default player states.', 'error');
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
    if (isGamePage && selectedTool === 'swap' && !boardEditingAllowed) {
        showMessage('Reset the game before editing the board.', 'error');
        return;
    }

    const rect = canvas.getBoundingClientRect();
    console.log("rect size: "+rect.width+":"+rect.height);
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mouseX = (event.clientX - rect.left) * scaleX / boardScale;
    const mouseY = (event.clientY - rect.top) * scaleY / boardScale;
    const placementHitRadius = 20 * Math.max(scaleX, scaleY) / boardScale;

    if (isGamePage && selectedTool !== 'swap') {
        if (gameRobberMoveSaving) return;
        if (!allPlayersData._started) {
            showMessage('Start the game before moving the robber.', 'error');
            return;
        }
        const robber = allPlayersData.robber;
        if (!robber || robber.q === 100) return;
        const robberPixel = hexToPixel(robber.q, robber.r, offsetX, offsetY);
        if (Math.hypot(mouseX - robberPixel.x, mouseY - robberPixel.y) < TILE_RADIUS * 0.45) {
            gameRobberMoveSelected = !gameRobberMoveSelected;
            showMessage(gameRobberMoveSelected ? 'Select a tile to move the robber.' : 'Robber move cancelled.');
            drawBoard();
            return;
        }
        if (!gameRobberMoveSelected) return;
        const clickedHex = pixelToHex(mouseX, mouseY, offsetX, offsetY);
        const clickedTile = boardTiles.find(tile => tile.q === clickedHex.q && tile.r === clickedHex.r);
        if (!clickedTile) return;
        gameRobberMoveSaving = true;
        try {
            const response = await fetch('/catan/move_robber', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ q: clickedTile.q, r: clickedTile.r })
            });
            const result = await response.json();
            if (!response.ok || result.status !== 'success') {
                showMessage(result.message || 'Could not move the robber.', 'error');
                return;
            }
            gameRobberMoveSelected = false;
            await loadAllPlayerStatesFromBackend();
            drawBoard();
            showMessage('Robber moved.');
        } catch (error) {
            showMessage(`Could not move the robber: ${error.message}`, 'error');
        } finally {
            gameRobberMoveSaving = false;
        }
        return;
    }

    let actionSuccessful = false;

    if (isGamePage) {
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
                        const desert = [selectedSwapItem1.tile, selectedSwapItem2.tile].find(tile => tile.type === 'desert');
                        if (desert) allPlayersData.robber = { q: desert.q, r: desert.r };
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
        if (!allPlayersData._started) {
            showMessage('Waiting for the game to start.', 'error');
            return;
        }
        if (allPlayersData._currentTurnPlayerId !== PLAYER_ID) {
            showMessage('Wait for your turn to build or move the robber.', 'error');
            return;
        }
        if (allPlayersData._robberPending) {
            const clickedHex = pixelToHex(mouseX, mouseY, offsetX, offsetY);
            const clickedTile = boardTiles.find(tile => tile.q === clickedHex.q && tile.r === clickedHex.r);
            const center = clickedTile && hexToPixel(clickedTile.q, clickedTile.r, offsetX, offsetY);
            if (center && Math.hypot(mouseX - center.x, mouseY - center.y) < TILE_RADIUS * 0.4) selectedPlayerTool = 'robber';
        }
        if (allPlayersData._phase === 'START_PHASE' && !['house', 'road'].includes(selectedPlayerTool)) return;
        if (allPlayersData._phase === 'MAIN_PHASE' && !allPlayersData._rolled && selectedPlayerTool !== 'robber') {
            showMessage('Roll before building.', 'error');
            return;
        }
        if (selectedPlayerTool === 'house') {
            if (allPlayersData._phase === 'START_PHASE' && allPlayersData[PLAYER_ID].structures.length > (allPlayersData._setupIndex >= allPlayersData._turnOrder.length ? 1 : 0)) return;
            const houseCount = (allPlayersData[PLAYER_ID].structures || []).filter(
                structure => structure.type === 'house'
            ).length;
            if (houseCount >= PLAYER_PIECE_LIMITS.house) {
                showMessage('You have no houses left. Upgrade one of your houses to a city before building another.', 'error');
                return;
            }
            
            const clickedJunction = getClosestJunction(mouseX, mouseY, placementHitRadius);
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
            const clickedJunction = getClosestJunction(mouseX, mouseY, placementHitRadius);
            if (clickedJunction) {
                const existingHouse = allPlayersData[PLAYER_ID].structures.find(s => s.junction.id === clickedJunction.id && s.type === 'house' && s.owner === PLAYER_ID);
                if (existingHouse) {
                    if(checkAndDeductCards(PLAYER_ID,selectedPlayerTool,true))
                    {
                        existingHouse.type = 'city';
                        updatePlayerUI();
                        actionSuccessful = true;
                    }
                } else {
                    showMessage('You must have a house here to build a city.', 'error');
                }
            }
        } else if (selectedPlayerTool === 'road') {
            if (allPlayersData._phase === 'START_PHASE' && allPlayersData[PLAYER_ID].roads.length > (allPlayersData._setupIndex >= allPlayersData._turnOrder.length ? 1 : 0)) return;
            const clickedEdge = getClosestEdge(mouseX, mouseY, placementHitRadius);
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
                    if (allPlayersData._phase === 'START_PHASE') {
                        const house = allPlayersData[PLAYER_ID].structures.at(-1);
                        if (!house || ![`${Math.round(clickedEdge.x1)},${Math.round(clickedEdge.y1)}`, `${Math.round(clickedEdge.x2)},${Math.round(clickedEdge.y2)}`].includes(house.junction.id)) {
                            return;
                        }
                    }
                    if(checkAndDeductCards(PLAYER_ID,selectedPlayerTool,true))
                    {
                        allPlayersData[PLAYER_ID].roads.push({ edge: clickedEdge, owner: PLAYER_ID });
                        if (allPlayersData._freeRoads > 0) allPlayersData._freeRoads--;
                        updateLongestRoadHolder();
                        updatePlayerUI();
                        actionSuccessful = true;
                    }
                }
            }
        } else if (selectedPlayerTool === 'robber') {
            if (!allPlayersData._robberPending) return;
            const clickedHex = pixelToHex(mouseX, mouseY, offsetX, offsetY);
            const clickedTile = boardTiles.find(t => t.q === clickedHex.q && t.r === clickedHex.r);
            if (clickedTile) {
                savePlayerStateToHistory();
                allPlayersData['robber'] = clickedTile;
                allPlayersData._robberPending = false;
                const victims = allPlayersData._turnOrder.filter(playerId => playerId !== PLAYER_ID && allPlayersData[playerId].structures.some(structure => {
                    if (!['house', 'city'].includes(structure.type)) return false;
                    const pixel = hexToPixel(clickedTile.q, clickedTile.r, 0, 0);
                    return Math.hypot(structure.junction.x - pixel.x, structure.junction.y - pixel.y) <= TILE_RADIUS * 1.3;
                }));
                if (victims.length) {
                    const choice = await choosePlayer(victims);
                    if (choice) await stealCards(PLAYER_ID, choice);
                } else {
                    showMessage('No players beside this hex to steal from.');
                }
                actionSuccessful = true;
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
            const actionMessage = actionMessages[selectedPlayerTool] || 'performed a game action';
            clearSelectedPlayerTool();
            const saved = await saveAllPlayerStatesToBackend();
            if (saved) socket.emit('game_action_log', { pid: PLAYER_ID, message: actionMessage });
        } else if (isGamePage) {
            saveBuilderState();
            await saveBoardTilesToBackend();
        }
    }
    drawBoard();
});

if (isGamePage) {
    document.querySelectorAll('#boardTools .map-tool').forEach(button => { button.dataset.label = button.title; });
    document.getElementById('boardTools').addEventListener('click', async (event) => {
        const target = event.target.closest('.map-tool[data-tool]');
        if (!target || target.disabled || !boardControlsEnabled) return;
        const tool = target.dataset.tool;

        if (tool === 'swap') {
            selectedTool = selectedTool === 'swap' ? null : 'swap';
            selectedSwapItem1 = null;
            selectedSwapItem2 = null;
            gameRobberMoveSelected = false;
            showMessage(selectedTool === 'swap' ? 'Swap mode: select two tiles or two numbers.' : 'Swap mode off.');
        } else if (tool === 'undo') {
            undoBuilderLastAction();
        } else if (tool === 'shuffle-cells') {
            shuffleCells();
        } else if (tool === 'shuffle-numbers') {
            shuffleNumbers();
        } else if (tool === 'reset-game') {
            if (await confirmReset()) await resetgame();
        }
        updateBoardEditingUI();
        drawBoard();
    });
}

if (isPlayerPage) {
    document.getElementById('player-tool-select').addEventListener('click', (event) => {
        const target = event.target.closest('.btn-tool');
        if (!target || target.id === 'rolldice') return;
        if (target.dataset.tool !== 'undo-player' && allPlayersData._currentTurnPlayerId !== PLAYER_ID) return;

        document.querySelectorAll('#player-tool-select .btn-tool').forEach(btn => btn.classList.remove('selected'));
        target.classList.add('selected');
        selectedPlayerTool = target.dataset.tool;
        if (selectedPlayerTool === 'undo-player') {
            undoPlayerLastAction();
        } else if (allPlayersData._phase === 'START_PHASE' && selectedPlayerTool === 'house') {
            showMessage('Place your free settlement at a junction.');
        } else if (allPlayersData._phase === 'START_PHASE' && selectedPlayerTool === 'road') {
            showMessage('Place your free road connected to your settlement.');
        }
    });



    const resourceCardButtons = document.querySelectorAll('.resource-card');
    resourceCardButtons.forEach(button => {
        button.addEventListener('click', () => {
            if (selectedHandCards.length > 0) {
                clearResourceSelection();
            }
            pendingResourceCards.push(button.dataset.resourceType);
            updateResourceSelectionTray('take');
        });
    });

    document.getElementById('clearResourceSelection').addEventListener('click', () => clearResourceSelection('take'));
    document.getElementById('clearHandSelection').addEventListener('click', () => clearResourceSelection('drop'));
    document.getElementById('toggleDevCards').addEventListener('click', event => {
        const cards = document.getElementById('devCards');
        const button = event.currentTarget;
        const expanded = cards.classList.toggle('concealed') === false;
        button.setAttribute('aria-expanded', String(expanded));
        button.title = expanded ? 'Hide development cards' : 'Show development cards';
        button.setAttribute('aria-label', button.title);
        button.querySelector('i').className = `fas ${expanded ? 'fa-eye-slash' : 'fa-eye'}`;
        cards.querySelectorAll('.dev-card').forEach(card => {
            card.setAttribute('aria-label', expanded ? card.dataset.cardType.replaceAll('_', ' ') : 'Development card (face down)');
        });
    });
    document.getElementById('turnButton').addEventListener('click', () => {
        const state = document.getElementById('turnButton').dataset.state;
        if (state === 'roll') rolldice();
        else if (state === 'end') {
            clearSelectedPlayerTool();
            socket.emit('end_catan_turn', { player_id: PLAYER_ID });
        }
    });
    document.querySelector('.player-map-shell .map-undo').addEventListener('click', undoPlayerLastAction);

    document.getElementById('confirmResourceSelection').addEventListener('click', () => {
        commitPendingResourceCards();
    });

    document.getElementById('dropSelectedCards').addEventListener('click', () => {
        transferOrDropSelectedCards(PLAYER_ID, 'NA');
    });

    document.getElementById('transferDropButtons').addEventListener('click', async event => {
        const button = event.target.closest('.transfer-btn');
        if (!button || selectedHandCards.length === 0) return;
        const targetPlayerId = button.dataset.targetPlayer;
        await transferOrDropSelectedCards(PLAYER_ID, targetPlayerId);
    });

    const devCardButton = document.querySelector('.player-controls .dev-card[data-resource-type="development"]');
    devCardButton.addEventListener('click', async () => {
        if (devCardButton.dataset.pending) return;
        if (allPlayersData._currentTurnPlayerId !== PLAYER_ID || allPlayersData._phase !== 'MAIN_PHASE') {
            return;
        }
        const confirmed = await showConfirmation('Do you want to take 1 Development card?');
        if (!confirmed || allPlayersData._currentTurnPlayerId !== PLAYER_ID) return;
        devCardButton.dataset.pending = 'true';
        try {
            const response = await fetch('/catan/buy_dev_card', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ player_id: PLAYER_ID })
            });
            const result = await response.json();
            if (!response.ok) {
                if (result.code === 'missing_resources') showMessage(result.message, 'error');
                return;
            }
            await loadAllPlayerStatesFromBackend();
            updatePlayerUI();
            showMessage(`You drew a ${result.cardType} Development Card!`);
        } catch (error) {
            showMessage(`Could not buy a Development Card: ${error.message}`, 'error');
        } finally {
            delete devCardButton.dataset.pending;
        }
    });
}

function checkAndDeductCards(playerId, actionType, recordUndo = false) {
    if (allPlayersData._phase === 'START_PHASE' && ['house', 'road'].includes(actionType)) {
        if (recordUndo) savePlayerStateToHistory();
        return true;
    }
    if (actionType === 'road' && allPlayersData._freeRoads > 0) {
        if (recordUndo) savePlayerStateToHistory();
        return true;
    }
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
    const otherPlayerIds = allPlayersData._turnOrder.filter(pId => pId !== PLAYER_ID);

    // Create buttons for other players
    otherPlayerIds.forEach(pId => {
        const button = document.createElement('button');
        button.type = 'button';
        button.classList.add('transfer-btn');
        button.dataset.targetPlayer = pId;
        button.textContent = allPlayersData[pId].playerName.slice(0, 5);
        button.title = `Give cards to ${allPlayersData[pId].playerName}`;
        button.setAttribute('aria-label', button.title);
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

function fitGameMap() {
    const map = isGamePage && document.querySelector('.game-map');
    if (!map || map.offsetParent === null) return;
    const available = window.innerHeight - (map.getBoundingClientRect().top + window.scrollY) - 12;
    map.style.maxWidth = `${Math.max(240, available * 1.2)}px`;
}

function resizeCanvas() {
    fitGameMap();
    
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
                cardItem.setAttribute('aria-label', devCardsDiv.classList.contains('concealed') ? 'Development card (face down)' : cardType.replaceAll('_', ' '));
                cardItem.addEventListener('click', () => {
                    if (!devCardsDiv.classList.contains('concealed')) playdevcard(PLAYER_ID, cardType);
                });
                devCardsDiv.appendChild(cardItem);
            }
        );
        document.getElementById('devCardCount').textContent = allPlayersData[PLAYER_ID].devCards.length;
        document.getElementById('victoryPointCount').textContent = Number(allPlayersData[PLAYER_ID].victory_point) || 0;
        document.getElementById('knightPlayedCount').textContent = Number(allPlayersData[PLAYER_ID].knightplayed) || 0;
    }
        renderTransferDropButtons();
        updateUndoButton();
        updateRollButton();
        
}
function updateResourceSelectionTray(mode = 'take') {
    const handMode = mode === 'drop';
    const tray = document.getElementById(handMode ? 'handSelectionPanel' : 'resourceSelectionTray');
    const details = document.getElementById(handMode ? 'handSelectionDetails' : 'resourceSelectionDetails');
    const confirmButton = document.getElementById(handMode ? 'dropSelectedCards' : 'confirmResourceSelection');
    const selectedResources = handMode ? selectedHandCards : pendingResourceCards;
    const counts = selectedResources.reduce((result, resourceType) => {
        result[resourceType] = (result[resourceType] || 0) + 1;
        return result;
    }, {});

    tray.dataset.mode = mode;
    tray.hidden = selectedResources.length === 0;
    if (handMode) document.getElementById('transferDropButtons').hidden = false;
    details.textContent = Object.entries(counts)
        .sort(([first], [second]) => ['wood', 'brick', 'rock', 'sheep', 'hay'].indexOf(first) - ['wood', 'brick', 'rock', 'sheep', 'hay'].indexOf(second))
        .map(([resourceType, count]) => `${count}${({ wood: 'W', brick: 'B', rock: 'R', sheep: 'S', hay: 'H' })[resourceType] || resourceType[0].toUpperCase()}`)
        .join(' ');
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

function clearResourceSelection(forcedMode) {
    const mode = forcedMode || document.querySelector('.resource-selection-tray:not([hidden])')?.dataset.mode || 'take';
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
    if (pendingResourceCards.length === 0 || cardActionPending) return;

    const selectedResources = [...pendingResourceCards];
    cardActionPending = true;
    try {
        const response = await fetch('/catan/card_action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ player_id: PLAYER_ID, cards: selectedResources, action: 'pickup' })
        });
        const result = await response.json();
        if (!response.ok || result.status !== 'success') {
            return;
        }
    } catch (error) {
        return;
    } finally {
        cardActionPending = false;
    }
    pendingResourceCards = [];
    updateResourceSelectionTray('take');
    await loadAllPlayerStatesFromBackend();
    updatePlayerUI();
}

function toggleCardSelection(cardElement, resourceType) {
    if (pendingResourceCards.length > 0) {
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
    if (cardActionPending || selectedHandCards.length === 0) {
        return;
    }
    const transferredCards = [...selectedHandCards];
    cardActionPending = true;
    try {
        const response = await fetch('/catan/card_action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                player_id: currentPlayerId,
                cards: transferredCards,
                target_id: targetPlayerId === 'NA' ? null : targetPlayerId
            })
        });
        const result = await response.json();
        if (!response.ok || result.status !== 'success') {
            return;
        }
    } catch (error) {
        return;
    } finally {
        cardActionPending = false;
    }
    selectedHandCards = [];
    document.getElementById('selectedCardCount').textContent = '0';
    updateResourceSelectionTray('drop');
    await loadAllPlayerStatesFromBackend();
    updatePlayerUI();
    const cardCounts = transferredCards.reduce((counts, resourceType) => {
        counts[resourceType] = (counts[resourceType] || 0) + 1;
        return counts;
    }, {});
    const resourceCodes = { wood: 'W', brick: 'B', rock: 'R', sheep: 'S', hay: 'H' };
    const cardSummary = Object.keys(resourceCodes)
        .filter(type => cardCounts[type])
        .map(type => `${cardCounts[type]}${resourceCodes[type]}`)
        .join(' ');
    const actionMessage = targetPlayerId === 'NA'
        ? `dropped ${cardSummary} (${transferredCards.length})`
        : `gave ${cardSummary} (${transferredCards.length}) to ${allPlayersData[targetPlayerId].playerName}`;
    socket.emit('game_action_log', { pid: currentPlayerId, message: actionMessage });
}
async function stealCards(currentPlayerId, targetPlayerId) {
    savePlayerStateToHistory(); // Save current state before modification
    const targetHandCards = allPlayersData[targetPlayerId].hand;
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
            message: `stole a card from ${allPlayersData[targetPlayerId].playerName}`
        });
    }
    updatePlayerUI(); 
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

function renderLastPlayedDevCard(entry) {
    if (!isGamePage) return;
    const container = document.getElementById('devCards');
    container.replaceChildren();
    if (!entry) {
        container.textContent = 'No card played yet';
        return;
    }
    const playerName = entry.playerName || allPlayersData[entry.pid]?.playerName || 'A player';
    const label = document.createElement('strong');
    label.textContent = `${playerName} played`;
    const card = document.createElement('div');
    card.className = 'card-item dev-card';
    card.dataset.cardType = entry.cardType;
    card.setAttribute('role', 'img');
    card.setAttribute('aria-label', entry.cardType.replaceAll('_', ' '));
    container.append(label, card);
}

function renderActivity(entries) {
    const container = document.getElementById('gameActivity');
    if (!container) return;
    container.replaceChildren();
    const devImages = {
        knight: 'Knight.jpg', road_building: 'Road_Building.jpg',
        year_of_plenty: 'Year_of_Plenty.jpg', monopoly: 'Monopoly.jpg', victory_point: 'victory_point.jpg'
    };
    function addCard(line, image, count, label) {
        const card = document.createElement('span');
        card.className = 'activity-card';
        card.title = `${count} ${label}`;
        const picture = document.createElement('img');
        picture.src = image;
        picture.alt = label;
        card.appendChild(picture);
        const badge = document.createElement('span');
        badge.textContent = count;
        card.appendChild(badge);
        line.appendChild(card);
    }
    for (const entry of entries) {
        const action = entry.action || (entry.message === 'bought a Development Card' ? 'bought' : undefined);
        if (!['picked', 'dropped', 'gave', 'bought', 'played', 'seven'].includes(action)
            && !/^(picked up|dropped |gave |bought a Development Card|played a Development Card)/i.test(entry.message || '')) continue;
        const line = document.createElement('div');
        line.className = 'activity-entry';
        if (action === 'seven') {
            const counts = Object.entries(entry.counts || {}).map(([playerId, count]) => `${allPlayersData[playerId]?.playerName || playerId}: ${count}`).join(', ');
            line.textContent = `Drop cards: ${counts || 'none'}`;
            container.appendChild(line);
            continue;
        }
        const playerName = allPlayersData[entry.pid]?.playerName || 'Player';
        const label = document.createElement('span');
        const verb = { picked: 'picked up', dropped: 'dropped', gave: 'gave', bought: 'took a', played: `played ${(entry.cardType || 'Development Card').replaceAll('_', ' ')}` };
        label.textContent = `${playerName} ${verb[action] || entry.message}${action === 'gave' && allPlayersData[entry.target] ? ` to ${allPlayersData[entry.target].playerName}` : ''}`;
        line.appendChild(label);
        if (entry.seven) {
            const seven = document.createElement('span');
            seven.className = 'activity-seven';
            seven.textContent = '7';
            seven.title = 'Discard after a 7';
            line.appendChild(seven);
        }
        for (const [resource, count] of Object.entries(entry.cards || {})) {
            if (resourceImagePaths[resource] && Number(count) > 0) addCard(line, resourceImagePaths[resource], count, resource);
        }
        if (action === 'bought') addCard(line, '/static/images/catan/dev_card.jpg', 1, 'Development Card');
        if (action === 'played' && devImages[entry.cardType]) addCard(line, `/static/images/catan/${devImages[entry.cardType]}`, 1, entry.cardType.replaceAll('_', ' '));
        container.appendChild(line);
    }
    container.scrollTop = container.scrollHeight;
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

function getDiceFaceHTML(value, color) {
    return `<div class="dice-face dice-${color}" role="img" aria-label="${color} die showing ${value}">${getDicePipHTML(value)}</div>`;
}

function setDiceFaceValue(face, value) {
    face.setAttribute('aria-label', `Die showing ${value}`);
    face.innerHTML = getDicePipHTML(value);
}

function renderGameDiceResult(dice, playerName = '') {
    const displayElement = document.getElementById('diceroll');
    if (!displayElement) return;
    displayElement.innerHTML = `<div class="dice-result" aria-live="polite">${getDiceFaceHTML(dice[0], 'red')}${getDiceFaceHTML(dice[1], 'yellow')}</div>`;
    const label = document.getElementById('lastRollPlayer');
    if (label) label.textContent = playerName;
    displayElement.classList.remove('rolling');
    displayElement.classList.add('final-roll');
}

function getDiceRollOverlay() {
    let overlay = document.getElementById('diceRollOverlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'diceRollOverlay';
    overlay.className = 'dice-roll-overlay catan-dice-roll-overlay';
    overlay.hidden = true;
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.setAttribute('aria-label', 'Rolling dice');
    overlay.setAttribute('tabindex', '0');
    overlay.innerHTML = '<div class="dice-roll-panel"><div class="dice-overlay-pair"><div class="dice-face dice-red" role="img" aria-label="Red die"></div><div class="dice-face dice-yellow" role="img" aria-label="Yellow die"></div></div></div>';
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
    overlay.hidden = false;
    overlay.classList.remove('is-result');
    overlay.classList.add('is-visible', 'is-rolling');
    overlay.setAttribute('aria-label', 'Rolling dice');

    const randomizeFaces = () => {
        faces.forEach(face => setDiceFaceValue(face, getRandomInt(1, 6)));
    };
    randomizeFaces();
    diceAnimationInterval = window.setInterval(randomizeFaces, 115);

    diceAnimationTimeout = window.setTimeout(() => {
        window.clearInterval(diceAnimationInterval);
        diceAnimationInterval = null;
        faces.forEach((face, index) => setDiceFaceValue(face, finalDice[index]));
        overlay.setAttribute('aria-label', `Dice result: ${finalDice[0]} and ${finalDice[1]}`);
        overlay.classList.remove('is-rolling');
        overlay.classList.add('is-result');

        renderGameDiceResult(finalDice, allPlayersData[allPlayersData._lastRoll?.player]?.playerName || '');

        diceOverlayHideTimeout = window.setTimeout(() => {
            overlay.classList.remove('is-visible', 'is-result');
            overlay.hidden = true;
        }, 5000);
    }, 1500);
}


function rolldice()
{
    if (!isPlayerPage || allPlayersData._currentTurnPlayerId !== PLAYER_ID || allPlayersData._phase !== 'MAIN_PHASE' || allPlayersData._rolled) {
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
});

socket.on('roll_dice_broadcast', (data) => {
    const dice = Array.isArray(data?.dice) && data.dice.length === 2
        && data.dice.every(value => Number.isInteger(value) && value >= 1 && value <= 6)
        ? data.dice
        : [getRandomInt(1, 6), getRandomInt(1, 6)];
    allPlayersData._rolled = true;
    allPlayersData._lastRoll = { dice, player: data.current_player };
    if (isPlayerPage) playPlayerSound(dice[0] + dice[1] === 7 ? 'danger' : 'roll');
    if (dice[0] + dice[1] === 7) {
        allPlayersData._robberPending = true;
        if (isPlayerPage && PLAYER_ID === data.current_player) selectedPlayerTool = 'robber';
    }
    updateRollButton();
    showSharedDiceRoll(dice);
});


function updateLargestArmyHolder() {
    const playerIds = Object.keys(allPlayersData).filter(playerId => playerId.startsWith('player'));
    const knightCounts = playerIds.map(playerId => Number(allPlayersData[playerId].knightplayed) || 0);
    const highestCount = Math.max(0, ...knightCounts);
    const currentHolder = playerIds.find(playerId => allPlayersData[playerId].largestarmy);
    if (currentHolder) {
        const holderCount = Number(allPlayersData[currentHolder].knightplayed) || 0;
        if (holderCount >= 3 && highestCount <= holderCount) return;
    }
    if (highestCount < 3) {
        playerIds.forEach(playerId => { allPlayersData[playerId].largestarmy = 0; });
        return;
    }

    const leaders = playerIds.filter(playerId => (Number(allPlayersData[playerId].knightplayed) || 0) === highestCount);
    if (leaders.length !== 1) return;

    playerIds.forEach(playerId => {
        allPlayersData[playerId].largestarmy = playerId === leaders[0] ? 1 : 0;
    });
}

async function playdevcard(currentPlayerId, item) {
    const cards = allPlayersData[currentPlayerId].devCards;
    if (!allPlayersData._started || allPlayersData._currentTurnPlayerId !== currentPlayerId || !cards.includes(item)) {
        return;
    }
    const confirmed = await showConfirmation(`Are you sure you want to play the ${item} card?`);
    if (confirmed) {
        if (!allPlayersData._started || allPlayersData._currentTurnPlayerId !== currentPlayerId || !allPlayersData[currentPlayerId].devCards.includes(item)) {
            return;
        }
        savePlayerStateToHistory(); // Save state before playing
        const index = allPlayersData[currentPlayerId].devCards.indexOf(item);
        if (index > -1) {
            allPlayersData[currentPlayerId].devCards.splice(index, 1); 
        }
            
        
        if(item === "knight")
        {
            allPlayersData[currentPlayerId].knightplayed +=1;
            updateLargestArmyHolder();
            allPlayersData._robberPending = true;
            selectedPlayerTool = 'robber';
        }else if (item === "victory_point")
        {
            allPlayersData[currentPlayerId].victory_point +=1;
        } else if (item === 'road_building') {
            allPlayersData._freeRoads = 2;
            selectedPlayerTool = 'road';
        } else if (item === 'monopoly') {
            const resource = await chooseResource();
            if (resource) {
                allPlayersData._turnOrder.filter(playerId => playerId !== currentPlayerId).forEach(playerId => {
                    const taken = allPlayersData[playerId].hand.filter(card => card === resource);
                    allPlayersData[playerId].hand = allPlayersData[playerId].hand.filter(card => card !== resource);
                    allPlayersData[currentPlayerId].hand.push(...taken);
                });
            }
        }
        const saved = await saveAllPlayerStatesToBackend(); // Save changes to backend
        updatePlayerUI(); // Update UI immediately
        if (!saved) return;
        
    } else return;
        socket.emit('dev_card_played', { 
            pid: currentPlayerId,
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
    const longestRoadDropdown = document.getElementById('roadChoices');
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
        row.cells[5].textContent = Number(player.victory_point) || 0;
        const inactive = /^player/i.test(player.playerName.trim());
        row.classList.toggle('unregistered-player', inactive);
        scoreboardBody.appendChild(row);

        const roadChoice = longestRoadDropdown.querySelector(`[data-player-id="${playerId}"]`);
        if (roadChoice) {
            roadChoice.textContent = player.playerName;
            roadChoice.hidden = inactive;
        }
    });

    const activeOwner = allPlayersData[longestRoadOwner]?.playerName;
    document.getElementById('roadHolder').textContent = activeOwner && !/^player/i.test(activeOwner.trim()) ? activeOwner : 'None';
    const currentPlayerId = allPlayersData._currentTurnPlayerId;
    const currentName = allPlayersData._started && allPlayersData[currentPlayerId]?.playerName;
    const title = document.getElementById('gameTurnTitle');
    title.textContent = currentName
        ? `Catan Game play (${currentName}'s Turn)` : 'Catan Game play (Waiting to start)';
    title.style.color = currentName ? window.CATAN_PLAYER_COLORS?.[currentPlayerId] || '' : '';
    document.getElementById('roadAwardButton').disabled = !allPlayersData._started || ![...longestRoadDropdown.querySelectorAll('button')].some(button => !button.hidden);
}

function toggleRoadChoices() {
    const choices = document.getElementById('roadChoices');
    choices.hidden = !choices.hidden;
    document.getElementById('roadAwardButton').setAttribute('aria-expanded', String(!choices.hidden));
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
        player.score = score;
    }

    renderGameScoreboard();
}
async function handleDropdownChange(selectedValue) {
    document.getElementById('roadChoices').hidden = true;
    document.getElementById('roadAwardButton').setAttribute('aria-expanded', 'false');
    const response = await fetch('/catan/longest_road', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ player_id: selectedValue })
    });
    if (!response.ok) showMessage('Could not assign longest road.', 'error');
}

async function onCatanPlayerPageLoad() {
    await loadAllStatesFromBackend();
    updatePlayerUI();
}

socket.on('catan_update', async () => {
    console.log('Received catan_update from server. Reloading state...');
    // Reload all states from the backend and update the UI
    await loadAllStatesFromBackend();
    updatePlayerUI();

    
});

socket.on('catan_card_transfer', data => {
    if (!isPlayerPage || (PLAYER_ID !== data.sender && PLAYER_ID !== data.recipient)) return;
    const cards = Object.entries(data.cards).map(([resource, count]) => `${count} ${resource}`).join(', ');
    showMessage(PLAYER_ID === data.sender
        ? `Sent ${cards} to ${data.recipientName}.`
        : `Received ${cards} from ${data.senderName}.`);
});

socket.on('dev_card_played_broadcast', (data) => {
    renderLastPlayedDevCard(data);
    if (isPlayerPage && data?.cardType === 'victory_point') void playPlayerSound('victory');
});

socket.on('score_update_broadcast', () => {
    renderGameScoreboard();
});

window.addEventListener('load', async () => {
    updateBoardEditingUI();
    await preloadImages();
    if (isPlayerPage) {
        await onCatanPlayerPageLoad();
    } else {
        await loadAllStatesFromBackend();
    }
});
window.addEventListener('resize', resizeCanvas);
