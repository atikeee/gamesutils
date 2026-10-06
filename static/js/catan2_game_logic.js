const canvas = document.getElementById('catanBoard');
const ctx = canvas.getContext('2d');
const messageBox = document.getElementById('messageBox');

const isGamePage = window.location.pathname === '/catan2/game';
const isPlayerPage = window.location.pathname.startsWith('/catan2/player/');
if (isPlayerPage && messageBox.parentElement !== document.body) {
    document.body.appendChild(messageBox);
}
if (isGamePage) {
    const viewButtons = document.querySelectorAll('.c2-game-mobile-tabs [data-game-view]');
    viewButtons.forEach(button => {
        button.addEventListener('click', () => {
            document.body.dataset.gameView = button.dataset.gameView;
            viewButtons.forEach(viewButton => {
                viewButton.setAttribute('aria-pressed', String(viewButton === button));
            });
            if (button.dataset.gameView === 'map') resizeCanvas();
        });
    });
}

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
const STARTING_HAND = ['wood', 'wood', 'wood', 'brick', 'brick', 'brick', 'sheep', 'hay', 'hay', 'hay', 'rock', 'rock', 'rock'];
let init_player_data = {
    'player1': { playerName: 'Player 1', hand: [...STARTING_HAND], roads: [], structures: [], history: [],longestroad: 0,largestarmy:0,knightplayed:0,merchant:0,victory_point:0,score:0 },
    'player2': { playerName: 'Player 2', hand: [...STARTING_HAND], roads: [], structures: [], history: [],longestroad: 0,largestarmy:0,knightplayed:0,merchant:0,victory_point:0,score:0 },
    'player3': { playerName: 'Player 3', hand: [...STARTING_HAND], roads: [], structures: [], history: [],longestroad: 0,largestarmy:0,knightplayed:0,merchant:0,victory_point:0,score:0 },
    'player4': { playerName: 'Player 4', hand: [...STARTING_HAND], roads: [], structures: [], history: [],longestroad: 0,largestarmy:0,knightplayed:0,merchant:0,victory_point:0,score:0 },
    'robber':{q:100,r:100},
    merchant: { q: 100, r: 100, owner: null },
    barbarianShipPosition: 0,
    lastDiceRoll: null,
    vpAwardLog: [],
    activityLog: [],
    metropolisOwners: { trade: null, politics: null, science: null }
}; 
let allPlayersData = init_player_data;
allPlayersData._turnOrder = [];
allPlayersData._currentTurnPlayerId = null;
allPlayersData._turnRolled = false;
allPlayersData._robberMoveAvailable = false;
allPlayersData._robberMovePlayerId = null;

const BARBARIAN_TRACK_CIRCLE_CENTERS = [
    { x: 84.7, y: 13.4 },
    { x: 56.7, y: 13.4 },
    { x: 28.0, y: 21.2 },
    { x: 43.3, y: 38.8 },
    { x: 62.5, y: 58.6 },
    { x: 73.8, y: 81.1 },
    { x: 44.5, y: 86.1 },
    { x: 14.4, y: 86.1 }
];

function updateBarbarianShipPosition() {
    const ship = document.getElementById('barbarianShip');
    if (!ship || !isGamePage) return;

    const position = Math.max(0, Math.min(7, Number(allPlayersData.barbarianShipPosition) || 0));
    const center = BARBARIAN_TRACK_CIRCLE_CENTERS[position];
    ship.style.left = `${center.x}%`;
    ship.style.top = `${center.y}%`;
    ship.title = `Barbarian ship on space ${position + 1} of 8`;
}

let shipMoveInProgress = false;
async function moveBarbarianShip(direction) {
    if (shipMoveInProgress) return;
    shipMoveInProgress = true;
    try {
        const response = await fetch('/catan2/load_play_state');
        const result = await response.json();
        if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Could not load game state');
        const state = result.play_state;
        const position = Math.max(0, Math.min(7, Number(state.barbarianShipPosition) || 0));
        const nextPosition = (position + (direction === 'forward' ? 1 : 7)) % BARBARIAN_TRACK_CIRCLE_CENTERS.length;
        state.barbarianShipPosition = nextPosition;
        if (nextPosition === BARBARIAN_TRACK_CIRCLE_CENTERS.length - 1) {
            Object.entries(state).forEach(([playerId, player]) => {
                if (!playerId.startsWith('player') || !player || !Array.isArray(player.structures)) return;
                player.structures.forEach(structure => {
                    if (structure.type === 'knight') structure.active = false;
                });
            });
        }
        allPlayersData.barbarianShipPosition = nextPosition;
        updateBarbarianShipPosition();
        const saveResponse = await fetch('/catan2/save_play_state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(state)
        });
        const saveResult = await saveResponse.json();
        if (!saveResponse.ok || saveResult.status !== 'success') throw new Error(saveResult.message || 'Could not save ship position');
    } catch (error) {
        showMessage(`Could not move barbarian ship: ${error.message}`, 'error');
    } finally {
        await loadAllPlayerStatesFromBackend();
        updateBarbarianShipPosition();
        shipMoveInProgress = false;
    }
}

document.getElementById('advanceBarbarianShip')?.addEventListener('click', () => {
    moveBarbarianShip('forward');
});
document.getElementById('retreatBarbarianShip')?.addEventListener('click', () => {
    moveBarbarianShip('backward');
});

const CARD_COSTS = {
    'road': { 'wood': 1, 'brick': 1 },
    'house': { 'wood': 1, 'brick': 1, 'sheep': 1, 'hay': 1 },
    'city': { 'rock': 3, 'hay': 2 },
    'wall': { 'brick': 2 },
    'knight': { 'rock': 1, 'sheep': 1 }
};
const PLAYER_PIECE_LIMITS = { house: 5, city: 4, road: 15 };
const PROGRESS_BOOK_COMMODITIES = { trade: 'cloth', politics: 'coin', science: 'paper' };
const PROGRESS_CARD_PASSIVE_CARDS = new Set(['victory_point', 'printer', 'constitution']);
const PROGRESS_CARD_ACTION_HANDLERS = {
    master_merchant: handleMasterMerchantProgressCard,
    trade_monopoly: handleTradeMonopolyProgressCard,
    resource_monopoly: handleResourceMonopolyProgressCard,
    bishop: handleBishopProgressCard,
    diplomat: handleDiplomatProgressCard,
    warlord: handleWarlordProgressCard,
    spy: handleSpyProgressCard,
    deserter: handleDeserterProgressCard,
    alchemist: handleAlchemistProgressCard,
    inventor: handleInventorProgressCard
};
const KNIGHT_LEVEL_NAMES = ['', 'basic', 'strong', 'mighty'];
const INVENTOR_LOCKED_NUMBERS = new Set([2, 6, 8, 12]);
let diplomatActive = false;
let pendingDeserterLevel = null;
let inventorFirstTile = null;

function formatCardName(cardName) {
    return String(cardName).replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase());
}

function getOpponentChoices(includePlayer) {
    return Object.keys(allPlayersData)
        .filter(playerId => playerId.startsWith('player') && playerId !== PLAYER_ID && allPlayersData[playerId])
        .filter(playerId => includePlayer(allPlayersData[playerId]))
        .map(playerId => ({ value: playerId, label: `${allPlayersData[playerId].playerName || playerId} (${Number(allPlayersData[playerId].score) || 0} VP)` }));
}

function getProgressCardActionConfig(cardName) {
    const displayName = formatCardName(cardName);
    const player = allPlayersData[PLAYER_ID];
    const myScore = Number(player?.score) || 0;
    const unavailable = message => ({ title: displayName, message, choices: [], confirmLabel: 'OK', unavailable: true });

    if (PROGRESS_CARD_PASSIVE_CARDS.has(cardName)) {
        return unavailable('This card is a victory point. It scores automatically, stays in your hand, and does not need to be played.');
    }
    if (cardName === 'master_merchant') {
        const choices = getOpponentChoices(opponent => (Number(opponent.score) || 0) > myScore);
        return choices.length
            ? { title: displayName, message: 'Choose a player with more victory points to see their hand.', choices }
            : unavailable('No player has more victory points than you.');
    }
    if (cardName === 'spy') {
        const choices = getOpponentChoices(opponent => (Number(opponent.score) || 0) >= myScore);
        return choices.length
            ? { title: displayName, message: 'Choose a player with the same or more victory points to see their Progress Cards.', choices }
            : unavailable('No player has the same or more victory points than you.');
    }
    if (cardName === 'resource_monopoly') {
        return {
            title: displayName,
            message: 'Choose a resource to ask every opponent for 2 of.',
            choices: ['wood', 'brick', 'rock', 'sheep', 'hay'].map(value => ({ value, label: formatCardName(value), image: `/static/images/catan/${value}.jpg` }))
        };
    }
    if (cardName === 'trade_monopoly') {
        return {
            title: displayName,
            message: 'Choose a commodity to ask every opponent for 1 of.',
            choices: ['paper', 'coin', 'cloth'].map(value => ({ value, label: formatCardName(value), image: `/static/images/catan/${value}.jpg` }))
        };
    }
    if (cardName === 'deserter') {
        const counts = updatePlayerKnightLevelCounts(player);
        const politics = Number(player.citiesAndKnights?.improvements?.politics) || 0;
        const choices = [1, 2, 3].map(level => {
            const levelName = KNIGHT_LEVEL_NAMES[level];
            const reason = counts[levelName] >= 2 ? `Both ${levelName} knights are already on the board`
                : level === 3 && politics < 3 ? 'Mighty knights require Politics level 3 or higher' : '';
            return { value: level, label: `Level ${level} (${formatCardName(levelName)})`, disabled: Boolean(reason), title: reason };
        });
        return choices.some(choice => !choice.disabled)
            ? { title: displayName, message: 'Choose the level of the free knight to place.', choices }
            : unavailable('You have no knight available to place.');
    }
    if (cardName === 'alchemist') {
        if (allPlayersData._currentTurnPlayerId !== PLAYER_ID || allPlayersData._turnRolled === true) {
            return unavailable('Alchemist must be played on your turn before rolling the dice.');
        }
        const dieChoices = [1, 2, 3, 4, 5, 6].map(value => ({ value, label: String(value) }));
        return {
            title: displayName,
            message: 'Choose the numbers for your next roll.',
            groups: [
                { name: 'red', label: 'Red die', choices: dieChoices, className: 'c2-die-choice-red' },
                { name: 'yellow', label: 'Yellow die', choices: dieChoices, className: 'c2-die-choice-yellow' }
            ]
        };
    }
    return { title: displayName, message: '', choices: [] };
}

function showProgressCardActionModal(config, cardName) {
    const modal = document.getElementById('progressCardActionModal');
    const title = document.getElementById('progressCardActionTitle');
    const message = document.getElementById('progressCardActionMessage');
    const choicesContainer = document.getElementById('progressCardActionChoices');
    const notesDisplay = document.getElementById('progressCardActionNotes');
    const confirmButton = document.getElementById('confirmProgressCardAction');
    const cancelButton = document.getElementById('cancelProgressCardAction');
    const groups = config.groups || [{ name: null, label: '', choices: config.choices || [], pickLimit: config.pickLimit || 1 }];
    const selections = groups.map(() => []);
    const requiredCount = group => Math.min(group.pickLimit || 1, group.choices.filter(choice => !choice.disabled).length);
    const refreshConfirm = () => {
        confirmButton.disabled = groups.some((group, index) => selections[index].length < requiredCount(group));
    };

    title.textContent = config.title;
    message.textContent = config.message;
    message.hidden = !config.message;
    const note = window.CATAN2_PROGRESS_CARD_NOTES?.[cardName] || '';
    notesDisplay.textContent = note;
    notesDisplay.hidden = !note;
    confirmButton.textContent = config.confirmLabel || 'Confirm';
    cancelButton.hidden = config.unavailable === true;
    choicesContainer.replaceChildren();

    groups.forEach((group, groupIndex) => {
        if (group.label) {
            const heading = document.createElement('p');
            heading.className = 'c2-progress-action-group-label';
            heading.textContent = group.label;
            choicesContainer.appendChild(heading);
        }
        const groupElement = document.createElement('div');
        groupElement.className = `c2-progress-action-group ${group.className || ''}`.trim();
        const buttons = group.choices.map(choice => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'c2-progress-action-choice';
            button.disabled = Boolean(choice.disabled);
            if (choice.title) button.title = choice.title;
            if (choice.image) {
                const image = document.createElement('img');
                image.src = choice.image;
                image.alt = '';
                button.appendChild(image);
            }
            const label = document.createElement('span');
            label.textContent = choice.label;
            button.appendChild(label);
            button.addEventListener('click', () => {
                // Keep only the most recent clicks, up to the group's pick limit.
                const selected = selections[groupIndex].filter(value => value !== choice.value);
                selected.push(choice.value);
                selections[groupIndex] = selected.slice(-(group.pickLimit || 1));
                buttons.forEach(({ element, value }) => element.classList.toggle('selected', selections[groupIndex].includes(value)));
                refreshConfirm();
            });
            groupElement.appendChild(button);
            return { element: button, value: choice.value };
        });
        choicesContainer.appendChild(groupElement);
    });
    refreshConfirm();

    return new Promise(resolve => {
        const finish = confirmed => {
            modal.classList.add('hidden');
            confirmButton.removeEventListener('click', onConfirm);
            cancelButton.removeEventListener('click', onCancel);
            cancelButton.hidden = false;
            const choice = config.groups
                ? Object.fromEntries(groups.map((group, index) => [group.name, selections[index][0]]))
                : (config.pickLimit || 1) > 1 ? selections[0] : selections[0][0] ?? null;
            resolve({ confirmed, choice });
        };
        const onConfirm = () => finish(true);
        const onCancel = () => finish(false);

        confirmButton.addEventListener('click', onConfirm);
        cancelButton.addEventListener('click', onCancel);
        modal.classList.remove('hidden');
    });
}

function announceProgressCardPlay(playerId, cardName, detail, logMessage, target) {
    const displayName = formatCardName(cardName);
    const playedLine = `played ${cardName}`;
    if (logMessage?.startsWith(playedLine)) {
        socket.emit('catan2_game_action_log', { pid: playerId, message: logMessage });
    } else {
        socket.emit('catan2_game_action_log', { pid: playerId, message: playedLine });
        if (logMessage) socket.emit('catan2_game_action_log', { pid: playerId, message: logMessage });
    }
    socket.emit('catan2_progress_card_played', { pid: playerId, card: cardName, target: target || null });
    showMessage(`${displayName} played.${detail ? ` ${detail}` : ''}`);
}

function removeOwnProgressCard(cardName) {
    const progressCards = allPlayersData[PLAYER_ID].citiesAndKnights.progressCards;
    const cardIndex = progressCards.indexOf(cardName);
    if (cardIndex >= 0) progressCards.splice(cardIndex, 1);
}

async function finishProgressCardPlay(cardName, detail, logMessage, target) {
    announceProgressCardPlay(PLAYER_ID, cardName, detail, logMessage, target);
    drawBoard();
    updatePlayerUI();
    await saveAllPlayerStatesToBackend();
}

async function playSimpleProgressCard(cardName, detail, logMessage, target) {
    savePlayerStateToHistory();
    removeOwnProgressCard(cardName);
    await finishProgressCardPlay(cardName, detail, logMessage, target);
}

function selectProgressCardBoardTool(tool, prompt) {
    selectedPlayerTool = tool;
    document.querySelectorAll('#player-tool-select .btn-tool').forEach(button => button.classList.remove('selected'));
    showMessage(prompt);
    document.querySelector('.canvas-wrapper')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function handleMasterMerchantProgressCard({ choice }) {
    const opponent = allPlayersData[choice];
    const opponentName = opponent?.playerName || choice;
    const hand = opponent?.hand || [];
    if (hand.length === 0) {
        showMessage(`${opponentName} has no cards to take.`, 'error');
        return;
    }
    const pickCount = Math.min(2, hand.length);
    const selection = await showProgressCardActionModal({
        title: `${opponentName}'s Hand`,
        message: `Select ${pickCount} card${pickCount === 1 ? '' : 's'}. Your most recent ${pickCount} click${pickCount === 1 ? '' : 's'} will be taken.`,
        choices: hand.map((card, index) => ({ value: index, label: formatCardName(card), image: `/static/images/catan/${card}.jpg` })),
        pickLimit: pickCount,
        confirmLabel: 'Take cards'
    }, 'master_merchant');
    if (!selection.confirmed) return;

    savePlayerStateToHistory();
    const takenCards = [...selection.choice].sort((first, second) => second - first).map(index => hand.splice(index, 1)[0]);
    allPlayersData[PLAYER_ID].hand.push(...takenCards);
    removeOwnProgressCard('master_merchant');
    await finishProgressCardPlay(
        'master_merchant',
        `You took ${takenCards.map(formatCardName).join(' and ')} from ${opponentName}.`,
        `takes ${takenCards.length} card${takenCards.length === 1 ? '' : 's'} from ${opponentName}`,
        opponentName
    );
}

async function handleTradeMonopolyProgressCard({ choice }) {
    await playSimpleProgressCard('trade_monopoly', `Ask each opponent for 1 ${choice}.`, `is asking for 1 ${choice}`, choice);
}

async function handleResourceMonopolyProgressCard({ choice }) {
    await playSimpleProgressCard('resource_monopoly', `Ask each opponent for 2 ${choice}.`, `is asking for 2 ${choice}`, choice);
}

async function handleBishopProgressCard() {
    savePlayerStateToHistory();
    allPlayersData._robberMoveAvailable = true;
    allPlayersData._robberMovePlayerId = PLAYER_ID;
    removeOwnProgressCard('bishop');
    await finishProgressCardPlay('bishop', 'Select the Robber tool, then click a hex to move the robber.');
}

async function handleDiplomatProgressCard() {
    diplomatActive = true;
    await playSimpleProgressCard('diplomat', 'Click one of your roads to move it, or an opponent\'s road to remove it.');
}

async function handleWarlordProgressCard() {
    savePlayerStateToHistory();
    const knights = (allPlayersData[PLAYER_ID].structures || []).filter(structure => structure.type === 'knight');
    knights.forEach(knight => {
        knight.active = true;
    });
    removeOwnProgressCard('warlord');
    await finishProgressCardPlay('warlord', `Activated ${knights.length} knight${knights.length === 1 ? '' : 's'} for free.`);
}

async function handleSpyProgressCard({ choice }) {
    const opponent = allPlayersData[choice];
    const opponentName = opponent?.playerName || choice;
    const opponentCards = opponent?.citiesAndKnights?.progressCards || [];
    const stealable = opponentCards
        .map((card, index) => ({ card, index }))
        .filter(({ card }) => !PROGRESS_CARD_PASSIVE_CARDS.has(card));
    if (stealable.length === 0) {
        showMessage(`${opponentName} has no Progress Cards you can take.`, 'error');
        return;
    }
    const selection = await showProgressCardActionModal({
        title: `${opponentName}'s Progress Cards`,
        message: 'Choose 1 card to take. Victory point cards cannot be taken.',
        choices: stealable.map(({ card, index }) => ({ value: index, label: formatCardName(card), image: resolveProgressCardImageUrl(card) })),
        confirmLabel: 'Take card'
    }, 'spy');
    if (!selection.confirmed || selection.choice === null) return;

    savePlayerStateToHistory();
    removeOwnProgressCard('spy');
    const [stolenCard] = opponentCards.splice(selection.choice, 1);
    allPlayersData[PLAYER_ID].citiesAndKnights.progressCards.push(stolenCard);
    await finishProgressCardPlay('spy', `You took ${formatCardName(stolenCard)} from ${opponentName}.`, `played spy on ${opponentName}`, opponentName);
}

function handleDeserterProgressCard({ choice }) {
    pendingDeserterLevel = Number(choice);
    selectProgressCardBoardTool('deserter', `Click an empty intersection on your road to place a free ${KNIGHT_LEVEL_NAMES[pendingDeserterLevel]} knight. Press Escape to cancel.`);
}

async function handleAlchemistProgressCard({ choice }) {
    try {
        const response = await fetch('/catan2/progress_card/alchemist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ player_id: PLAYER_ID, red: choice.red, yellow: choice.yellow })
        });
        const result = await response.json();
        if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Could not play Alchemist');
        removeOwnProgressCard('alchemist');
        updatePlayerUI();
        showMessage(`Alchemist played. Your next roll will be red ${choice.red} and yellow ${choice.yellow}.`);
    } catch (error) {
        showMessage(error.message, 'error');
    }
}

function handleInventorProgressCard() {
    inventorFirstTile = null;
    selectProgressCardBoardTool('inventor', 'Click two number tokens to swap (2, 6, 8 and 12 cannot be chosen). Press Escape to cancel.');
    drawBoard();
}

async function swapNumbersWithInventor(firstTile, secondTile) {
    try {
        const response = await fetch('/catan2/progress_card/inventor', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                player_id: PLAYER_ID,
                tiles: [{ q: firstTile.q, r: firstTile.r }, { q: secondTile.q, r: secondTile.r }]
            })
        });
        const result = await response.json();
        if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Could not play Inventor');
        removeOwnProgressCard('inventor');
        updatePlayerUI();
        showMessage(`Inventor played. Swapped ${firstTile.number} and ${secondTile.number}.`);
    } catch (error) {
        showMessage(error.message, 'error');
    }
}

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
let selectedKnightActionTarget = null;
let selectedKnightToMove = null;
let knightMenuToolbarState = null;
let selectedBoardPieceAction = null;
let selectedRoadToMove = null;

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
function normalizeCitiesAndKnightsState(source = {}) {
    const improvements = source.improvements || {};
    const knights = source.knights || {};
    const boundedCount = (value, maximum) => {
        const count = Number.parseInt(value, 10);
        return Number.isFinite(count) ? Math.min(maximum, Math.max(0, count)) : 0;
    };

    return {
        improvements: {
            trade: boundedCount(improvements.trade, 5),
            politics: boundedCount(improvements.politics, 5),
            science: boundedCount(improvements.science, 5)
        },
        knights: {
            basic: boundedCount(knights.basic, 2),
            strong: boundedCount(knights.strong, 2),
            mighty: boundedCount(knights.mighty, 2)
        },
        progressCards: Array.isArray(source.progressCards)
            ? source.progressCards.filter(card => typeof card === 'string').slice(0, 5)
            : [],
        pendingProgressReplacement: source.pendingProgressReplacement === true,
        pendingDiscardedProgressCard: typeof source.pendingDiscardedProgressCard === 'string'
            ? source.pendingDiscardedProgressCard : null,
        cityWalls: boundedCount(source.cityWalls, 3),
        metropolis: ['trade', 'politics', 'science'].includes(source.metropolis) ? source.metropolis : ''
    };
}

function updatePlayerKnightLevelCounts(player) {
    player.citiesAndKnights = normalizeCitiesAndKnightsState(player.citiesAndKnights);
    const counts = { basic: 0, strong: 0, mighty: 0 };
    const levelNames = { 1: 'basic', 2: 'strong', 3: 'mighty' };

    (player.structures || []).forEach(structure => {
        if (structure.type !== 'knight') return;
        const level = Math.max(1, Math.min(3, Number(structure.knightLevel) || 1));
        structure.knightLevel = level;
        counts[levelNames[level]]++;
    });

    player.citiesAndKnights.knights = counts;
    return counts;
}

// Mighty knights need the politics book at level 3+ (the Fortress in the official rules).
function getKnightLevelUpBlockReason(player, level, levelCounts) {
    if (level >= 3) return 'Maximum knight level reached';
    const nextLevelName = { 1: 'strong', 2: 'mighty' }[level];
    if (levelCounts[nextLevelName] >= 2) return 'No knight pieces are available at the next level';
    if (level + 1 === 3 && (Number(player.citiesAndKnights?.improvements?.politics) || 0) < 3) {
        return 'Mighty knights require Politics level 3 or higher';
    }
    return null;
}

function updatePlayerCityWallCount(player) {
    player.citiesAndKnights = normalizeCitiesAndKnightsState(player.citiesAndKnights);
    const wallCount = (player.structures || []).filter(structure =>
        structure.type === 'city' && structure.hasWall === true
    ).length;
    player.citiesAndKnights.cityWalls = Math.min(3, wallCount);
    return player.citiesAndKnights.cityWalls;
}

function setKnightMenuToolbarLock(locked) {
    const toolbarButtons = [...document.querySelectorAll('#player-tool-select button')];
    if (locked) {
        if (knightMenuToolbarState) return;
        knightMenuToolbarState = toolbarButtons.map(button => ({ button, disabled: button.disabled }));
        toolbarButtons.forEach(button => {
            button.disabled = true;
        });
        return;
    }

    if (!knightMenuToolbarState) return;
    knightMenuToolbarState.forEach(({ button, disabled }) => {
        button.disabled = disabled;
    });
    knightMenuToolbarState = null;
}

function openBoardPieceActionMenu(pieceType, piece, ownerId = PLAYER_ID) {
    setKnightMenuToolbarLock(true);
    selectedBoardPieceAction = { pieceType, piece, ownerId };
    const title = document.getElementById('boardPieceActionTitle');
    const message = document.getElementById('boardPieceActionMessage');
    const choices = document.getElementById('boardPieceActionChoices');
    const isOpponentRoad = pieceType === 'opponent-road';
    const isRobber = pieceType === 'robber';
    title.hidden = isRobber;
    message.hidden = false;
    message.classList.toggle('c2-compact-action-text', isRobber);
    document.getElementById('boardPieceActionModal').classList.toggle('c2-compact-action-modal', isRobber);
    if (isRobber) {
        message.textContent = 'Move robber';
        document.getElementById('boardPieceActionModal').setAttribute('aria-label', 'Move Robber');
        choices.replaceChildren();
        appendBoardPieceActionButtons(choices, [{ value: 'move', label: 'Move Robber', icon: 'fa-arrows-alt' }]);
        document.getElementById('boardPieceActionModal').classList.remove('hidden');
        return;
    }
    title.textContent = isOpponentRoad ? `${allPlayersData[ownerId]?.playerName || ownerId}'s Road` : pieceType === 'road' ? 'Road' : 'City';
    message.textContent = isOpponentRoad
        ? 'Diplomat: remove this road and return it to its owner.'
        : pieceType === 'road'
        ? 'Move it to a free edge or remove it from the board.'
        : piece.hasWall ? 'Choose a city action.' : 'Convert this city to a house?';
    choices.replaceChildren();

    const actions = isOpponentRoad
        ? [{ value: 'remove', label: 'Remove road', icon: 'fa-trash' }]
        : pieceType === 'road'
        ? [
            { value: 'move', label: 'Move road', icon: 'fa-arrows-alt' },
            { value: 'remove', label: 'Remove road', icon: 'fa-trash' }
        ]
        : [{ value: 'house', label: 'Convert city to house', icon: 'fa-home' }];
    if (pieceType === 'city' && piece.hasWall) {
        actions.push({ value: 'remove-wall', label: 'Remove wall', icon: 'fa-minus' });
    }
    appendBoardPieceActionButtons(choices, actions);
    document.getElementById('boardPieceActionModal').classList.remove('hidden');
}

function appendBoardPieceActionButtons(choices, actions) {
    actions.forEach(action => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'c2-board-piece-action-option';
        button.dataset.boardPieceAction = action.value;
        button.title = action.label;
        button.setAttribute('aria-label', action.label);
        const icon = document.createElement('i');
        icon.className = `fas ${action.icon}`;
        icon.setAttribute('aria-hidden', 'true');
        button.appendChild(icon);
        choices.appendChild(button);
    });
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.id = 'cancelBoardPieceAction';
    cancelButton.className = 'c2-board-piece-action-option c2-board-piece-action-cancel';
    cancelButton.title = 'Cancel';
    cancelButton.setAttribute('aria-label', 'Cancel');
    const cancelIcon = document.createElement('i');
    cancelIcon.className = 'fas fa-times';
    cancelIcon.setAttribute('aria-hidden', 'true');
    cancelButton.appendChild(cancelIcon);
    choices.appendChild(cancelButton);
}

function closeBoardPieceActionMenu() {
    document.getElementById('boardPieceActionModal').classList.add('hidden');
    selectedBoardPieceAction = null;
    setKnightMenuToolbarLock(false);
}

async function applyBoardPieceAction(action) {
    if (!selectedBoardPieceAction) return;
    const { pieceType, piece, ownerId } = selectedBoardPieceAction;
    const player = allPlayersData[PLAYER_ID];
    const ownerName = allPlayersData[ownerId]?.playerName || ownerId;

    if (pieceType === 'robber' && action === 'move') {
        closeBoardPieceActionMenu();
        if (canPlayerMoveRobber()) selectRobberTool();
        return;
    }

    if (pieceType === 'road' && action === 'move') {
        selectedRoadToMove = piece;
        selectedBoardPieceAction = null;
        document.getElementById('boardPieceActionModal').classList.add('hidden');
        showMessage('Click an unoccupied edge to move this road. Press Escape to cancel.');
        return;
    }

    if (pieceType === 'opponent-road' && action === 'remove') {
        const ownerRoads = allPlayersData[ownerId]?.roads || [];
        const roadIndex = ownerRoads.indexOf(piece);
        if (!diplomatActive || roadIndex < 0) return closeBoardPieceActionMenu();
        savePlayerStateToHistory();
        ownerRoads.splice(roadIndex, 1);
        diplomatActive = false;
        updateLongestRoadHolder();
    } else if (pieceType === 'road' && action === 'remove') {
        const roadIndex = (player.roads || []).indexOf(piece);
        if (roadIndex < 0) return closeBoardPieceActionMenu();
        savePlayerStateToHistory();
        player.roads.splice(roadIndex, 1);
        diplomatActive = false;
        updateLongestRoadHolder();
    } else if (pieceType === 'city' && action === 'house') {
        if (!(player.structures || []).includes(piece)) return closeBoardPieceActionMenu();
        savePlayerStateToHistory();
        if (piece.hasWall) {
            piece.hasWall = false;
            updatePlayerCityWallCount(player);
        }
        piece.type = 'house';
    } else if (pieceType === 'city' && action === 'remove-wall' && piece.hasWall) {
        if (!(player.structures || []).includes(piece)) return closeBoardPieceActionMenu();
        savePlayerStateToHistory();
        piece.hasWall = false;
        updatePlayerCityWallCount(player);
    } else {
        return;
    }

    const actionMessage = pieceType === 'opponent-road'
        ? `removed ${ownerName}'s road with Diplomat`
        : pieceType === 'road'
        ? 'removed a road from the board'
        : action === 'remove-wall' ? 'removed a city wall' : 'converted a city to a house';
    closeBoardPieceActionMenu();
    showMessage(`You ${actionMessage}.`);
    socket.emit('catan2_game_action_log', { pid: PLAYER_ID, message: actionMessage });
    drawBoard();
    updatePlayerUI();
    await saveAllPlayerStatesToBackend();
}

function openKnightActionMenu(knight) {
    setKnightMenuToolbarLock(true);
    selectedKnightActionTarget = knight;
    const level = Math.max(1, Math.min(3, Number(knight.knightLevel) || 1));
    const levelNames = { 1: 'Basic', 2: 'Strong', 3: 'Mighty' };
    const player = allPlayersData[PLAYER_ID];
    const levelCounts = updatePlayerKnightLevelCounts(player);
    const freeUpButton = document.querySelector('[data-knight-action="free-up"]');
    const payUpButton = document.querySelector('[data-knight-action="pay-up"]');
    const moveButton = document.querySelector('[data-knight-action="move"]');
    const attackButton = document.querySelector('[data-knight-action="attack"]');
    const activateButton = document.querySelector('[data-knight-action="activate"]');

    document.getElementById('knightActionTitle').textContent = `${levelNames[level]} Knight (${knight.active ? 'active' : 'inactive'})`;
    const levelUpBlockReason = getKnightLevelUpBlockReason(player, level, levelCounts);
    freeUpButton.disabled = Boolean(levelUpBlockReason);
    freeUpButton.title = levelUpBlockReason || `Free level up to ${levelNames[level + 1]}`;
    freeUpButton.setAttribute('aria-label', freeUpButton.title);
    payUpButton.disabled = Boolean(levelUpBlockReason);
    payUpButton.title = levelUpBlockReason || `Pay 1 rock and 1 sheep to level up to ${levelNames[level + 1]}`;
    payUpButton.setAttribute('aria-label', payUpButton.title);
    moveButton.disabled = !knight.active;
    moveButton.title = knight.active ? 'Choose a destination on one of your roads' : 'Activate this knight before moving it';
    moveButton.setAttribute('aria-label', moveButton.title);
    const robberNearby = isRobberAdjacentToJunction(knight.junction);
    attackButton.disabled = !knight.active || !robberNearby;
    attackButton.title = !knight.active
        ? 'Activate this knight before attacking'
        : robberNearby ? 'Move the robber from an adjacent hex' : 'No robber in an adjacent hex';
    attackButton.setAttribute('aria-label', attackButton.title);
    activateButton.disabled = Boolean(knight.active);
    activateButton.title = knight.active ? 'This knight is already active' : 'Activate this knight for 1 grain';
    activateButton.setAttribute('aria-label', activateButton.title);
    document.getElementById('knightActionModal').classList.remove('hidden');
}

async function applyKnightAction(action) {
    const player = allPlayersData[PLAYER_ID];
    const structures = player.structures || [];
    const knightIndex = structures.indexOf(selectedKnightActionTarget);
    if (knightIndex < 0) return;

    const knight = structures[knightIndex];
    const level = Math.max(1, Math.min(3, Number(knight.knightLevel) || 1));
    const modal = document.getElementById('knightActionModal');
    let actionMessage;

    if (action === 'free-up') {
        const blockReason = getKnightLevelUpBlockReason(player, level, updatePlayerKnightLevelCounts(player));
        if (blockReason) {
            showMessage(`${blockReason}.`, 'error');
            return;
        }
        savePlayerStateToHistory();
        knight.knightLevel = level + 1;
        actionMessage = `leveled up a knight to ${['', 'basic', 'strong', 'mighty'][knight.knightLevel]}`;
    } else if (action === 'pay-up') {
        const blockReason = getKnightLevelUpBlockReason(player, level, updatePlayerKnightLevelCounts(player));
        if (blockReason) {
            showMessage(`${blockReason}.`, 'error');
            return;
        }
        if (!checkAndDeductCards(PLAYER_ID, 'knight', true)) return;
        knight.knightLevel = level + 1;
        actionMessage = `paid rock and sheep to level up a knight to ${['', 'basic', 'strong', 'mighty'][knight.knightLevel]}`;
    } else if (action === 'activate') {
        if (knight.active) return;
        const grainIndex = player.hand.indexOf('hay');
        if (grainIndex < 0) {
            showMessage('You need 1 grain to activate this knight.', 'error');
            return;
        }
        savePlayerStateToHistory();
        player.hand.splice(grainIndex, 1);
        knight.active = true;
        actionMessage = 'activated a knight';
    } else if (action === 'remove') {
        savePlayerStateToHistory();
        structures.splice(knightIndex, 1);
        actionMessage = 'removed a knight from the board';
    } else {
        return;
    }

    updatePlayerKnightLevelCounts(player);
    selectedKnightActionTarget = null;
    modal.classList.add('hidden');
    setKnightMenuToolbarLock(false);
    showMessage(`You ${actionMessage}.`);
    socket.emit('catan2_game_action_log', { pid: PLAYER_ID, message: actionMessage });
    drawBoard();
    updatePlayerUI();
    await saveAllPlayerStatesToBackend();
}

async function upgradeProgressBook(track) {
    if (!Object.hasOwn(PROGRESS_BOOK_COMMODITIES, track)) return;

    const player = allPlayersData[PLAYER_ID];
    player.citiesAndKnights = normalizeCitiesAndKnightsState(player.citiesAndKnights);
    const improvements = player.citiesAndKnights.improvements;
    const currentLevel = improvements[track];
    if (currentLevel >= 5) {
        showMessage(`${track[0].toUpperCase()}${track.slice(1)} is already at the maximum level.`, 'error');
        return;
    }

    const commodity = PROGRESS_BOOK_COMMODITIES[track];
    const cost = currentLevel + 1;
    const hand = player.hand || [];
    const available = hand.filter(card => card === commodity).length;
    if (available < cost) {
        showMessage(`You need ${cost} ${commodity} to upgrade ${track}.`, 'error');
        return;
    }

    savePlayerStateToHistory();
    for (let cardNumber = 0; cardNumber < cost; cardNumber++) {
        hand.splice(hand.indexOf(commodity), 1);
    }
    improvements[track] = currentLevel + 1;
    showMessage(`${track[0].toUpperCase()}${track.slice(1)} upgraded to level ${improvements[track]}.`);
    socket.emit('catan2_game_action_log', {
        pid: PLAYER_ID,
        message: `upgraded ${track} to level ${improvements[track]}`
    });
    updatePlayerUI();
    await saveAllPlayerStatesToBackend();
}

let selectedProgressBookTrack = null;

function closeProgressBookActionMenu() {
    document.getElementById('progressBookActionModal').classList.add('hidden');
    selectedProgressBookTrack = null;
}

function openProgressBookActionMenu(track) {
    if (!Object.hasOwn(PROGRESS_BOOK_COMMODITIES, track)) return;
    const level = allPlayersData[PLAYER_ID].citiesAndKnights.improvements[track];
    const upgradeButton = document.getElementById('confirmProgressBookUpgrade');
    selectedProgressBookTrack = track;
    document.getElementById('progressBookActionTitle').textContent = `${track[0].toUpperCase()}${track.slice(1)} Progress`;
    upgradeButton.disabled = level >= 5;
    document.getElementById('progressBookActionModal').classList.remove('hidden');
    (upgradeButton.disabled ? document.getElementById('cancelProgressBookUpgrade') : upgradeButton).focus();
}

Object.keys(allPlayersData).filter(playerId => playerId.startsWith('player')).forEach(playerId => {
    allPlayersData[playerId].citiesAndKnights = normalizeCitiesAndKnightsState(allPlayersData[playerId].citiesAndKnights);
});

let playerMessageTimeout = null;

function dismissPlayerMessage() {
    if (playerMessageTimeout !== null) {
        window.clearTimeout(playerMessageTimeout);
        playerMessageTimeout = null;
    }
    messageBox.replaceChildren();
    messageBox.className = 'message-box';
    messageBox.hidden = true;
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

    if (isPlayerPage) {
        if (playerMessageTimeout !== null) window.clearTimeout(playerMessageTimeout);
        messageBox.replaceChildren();
        messageBox.className = `message-box catan-player-notification ${type === 'error' ? 'catan-player-notification-error' : 'catan-player-notification-info'}`;
        const messageText = document.createElement('span');
        messageText.textContent = message;
        const dismissButton = document.createElement('button');
        dismissButton.type = 'button';
        dismissButton.className = 'catan-player-notification-close';
        dismissButton.title = 'Dismiss notification';
        dismissButton.setAttribute('aria-label', 'Dismiss notification');
        const closeIcon = document.createElement('i');
        closeIcon.className = 'fas fa-times';
        closeIcon.setAttribute('aria-hidden', 'true');
        dismissButton.appendChild(closeIcon);
        dismissButton.addEventListener('click', dismissPlayerMessage);
        messageBox.append(messageText, dismissButton);
        messageBox.hidden = false;
        playerMessageTimeout = window.setTimeout(dismissPlayerMessage, 5000);
        return;
    }

    messageBox.textContent = message;
    messageBox.className = `message-box ${type === 'error' ? 'bg-red-100 text-red-800 border-red-300' : 'bg-yellow-100 text-yellow-800 border-orange-300'}`;
}

function showConfirmation(message, confirmLabel = 'Confirm', cancelLabel = 'Cancel') {
    modalMessage.textContent = message;
    modalConfirmBtn.textContent = confirmLabel;
    modalCancelBtn.textContent = cancelLabel;
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
                        if (structure.hasWall) {
                            drawCityWall(ctx, structure.junction, ownerColor, offsetX, offsetY);
                        }
                    } else if (structure.type === 'knight') {
                        drawKnight(
                            ctx,
                            structure.junction,
                            ownerColor,
                            offsetX,
                            offsetY,
                            structure.knightLevel,
                            structure.active
                        );
                    }
                });
            }
        }
    }

    if (isRobberOnBoard()) {
        const robberReady = isPlayerPage && canPlayerMoveRobber();
        const revealNumber = isPlayerPage && selectedPlayerTool === 'inventor';
        if (robberReady && !revealNumber) drawRobberReadyGlow();
        ctx.save();
        // Fade the robber so Inventor players can read the number token under it.
        if (revealNumber) ctx.globalAlpha = 0.2;
        else if (robberReady) {
            ctx.shadowColor = '#ffee00';
            ctx.shadowBlur = 18 + 18 * (Math.sin(Date.now() / 200) + 1) / 2;
        }
        drawRobber(ctx, allPlayersData['robber'], offsetX, offsetY);
        ctx.restore();
    }
    if (allPlayersData.merchant && allPlayersData.merchant.q !== 100 && allPlayersData.merchant.r !== 100) {
        const merchantOwner = allPlayersData.merchant.owner;
        drawMerchant(ctx, allPlayersData.merchant, PLAYER_COLORS[merchantOwner], offsetX, offsetY);
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
    undoStack.push({ state });
    if (undoStack.length > 3) undoStack.shift();
    allPlayersData._undoStack = undoStack;
    updateUndoButton();
}

function updateUndoButton() {
    const button = document.getElementById('undoButton');
    if (!button) return;
    const undoCount = Array.isArray(allPlayersData._undoStack) ? allPlayersData._undoStack.length : 0;
    button.disabled = undoCount === 0;
    button.title = undoCount > 0 ? `Undo last action (${undoCount} available)` : 'Undo unavailable';
    button.setAttribute('aria-disabled', String(undoCount === 0));
}

let turnRequestPending = false;

function updateGameStartUI() {
    const gameStarted = allPlayersData._gameStarted !== false;
    if (isPlayerPage) {
        document.body.classList.toggle('c2-awaiting-start', !gameStarted);
        const banner = document.getElementById('awaitingStartBanner');
        if (banner) banner.hidden = gameStarted;
    }
    const startButton = document.getElementById('startGameButton');
    if (startButton) {
        startButton.disabled = gameStarted;
        startButton.textContent = gameStarted ? 'Started' : 'Start';
        startButton.title = gameStarted ? 'Game already started. Reset the game from the board page to start again.' : 'Randomize the player order and start the game';
    }
}

document.getElementById('startGameButton')?.addEventListener('click', async () => {
    const startButton = document.getElementById('startGameButton');
    if (startButton.disabled) return;
    startButton.disabled = true;
    try {
        const response = await fetch('/catan2/start_game', { method: 'POST' });
        const result = await response.json();
        if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Could not start the game');
        showMessage(`Game started. Order: ${result.order.join(' > ')}`);
    } catch (error) {
        showMessage(error.message, 'error');
        updateGameStartUI();
    }
});

function updateRollButton() {
    updateGameStartUI();
    const button = document.getElementById('turnButton');
    if (!button) return;

    const currentPlayerId = allPlayersData._currentTurnPlayerId;
    const gameStarted = allPlayersData._gameStarted !== false;
    const isMyTurn = gameStarted && isPlayerPage && currentPlayerId === PLAYER_ID;
    const isSetup = allPlayersData._turnPhase === 'setup';
    const currentPlayerName = allPlayersData[currentPlayerId]?.playerName || 'the next player';
    const colorsReady = allPlayersData._colorsReady !== false;
    const state = !isMyTurn ? 'waiting'
        : turnRequestPending ? 'busy'
        : allPlayersData._turnRolled === true ? 'end'
        : colorsReady ? 'roll' : 'waiting';
    button.dataset.state = state;
    button.querySelector('i').className = `fas ${state === 'end' ? 'fa-check' : state === 'busy' ? 'fa-spinner fa-spin' : 'fa-dice'}`;
    button.title = {
        waiting: !gameStarted ? 'Waiting for the game to start'
            : isMyTurn ? 'Waiting for every player to choose a color' : `Not your turn. Waiting for ${currentPlayerName} to finish`,
        busy: 'Please wait…',
        roll: 'Roll dice',
        end: isSetup ? 'Finish your setup turn' : 'End your turn'
    }[state];
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-disabled', String(state === 'waiting' || state === 'busy'));
}

async function onTurnButtonClick() {
    const state = document.getElementById('turnButton')?.dataset.state;
    if (state === 'roll') {
        rolldice();
        return;
    }
    if (state !== 'end') return;
    const confirmed = await showConfirmation('Finish your turn and pass the dice to the next player?', 'End turn', 'Keep playing');
    if (!confirmed || document.getElementById('turnButton')?.dataset.state !== 'end') return;
    markTurnRequestPending();
    socket.emit('catan2_end_turn', { player_id: PLAYER_ID });
}

document.getElementById('turnButton')?.addEventListener('click', onTurnButtonClick);
document.getElementById('undoButton')?.addEventListener('click', () => {
    document.querySelectorAll('#player-tool-select .btn-tool').forEach(button => button.classList.remove('selected'));
    selectedPlayerTool = null;
    undoPlayerLastAction();
});

function canPlayerMoveRobber() {
    return isPlayerPage
        && allPlayersData._robberMoveAvailable === true
        && allPlayersData._robberMovePlayerId === PLAYER_ID;
}

function isRobberOnBoard() {
    const robber = allPlayersData.robber;
    return Boolean(robber) && robber.q !== 100 && robber.r !== 100;
}

let robberReadyShown = false;
let robberGlowInterval = null;

function updateRobberToolAvailability() {
    if (!isPlayerPage) return;
    const canMove = canPlayerMoveRobber();
    if (!canMove && selectedPlayerTool === 'robber') selectedPlayerTool = null;
    if (canMove !== robberReadyShown) {
        robberReadyShown = canMove;
        window.clearInterval(robberGlowInterval);
        robberGlowInterval = canMove && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? window.setInterval(drawBoard, 80)
            : null;
        drawBoard();
    }
}

function drawRobberReadyGlow() {
    const pixel = hexToPixel(allPlayersData.robber.q, allPlayersData.robber.r, offsetX, offsetY);
    const pulse = (Math.sin(Date.now() / 200) + 1) / 2;
    const radius = HEX_SIZE * (0.5 + 0.12 * pulse);
    ctx.save();
    const halo = ctx.createRadialGradient(pixel.x, pixel.y, HEX_SIZE * 0.1, pixel.x, pixel.y, radius * 1.4);
    halo.addColorStop(0, 'rgba(255, 230, 0, 0.95)');
    halo.addColorStop(0.45, 'rgba(255, 140, 0, 0.7)');
    halo.addColorStop(1, 'rgba(255, 40, 0, 0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(pixel.x, pixel.y, radius * 1.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(pixel.x, pixel.y, radius, 0, Math.PI * 2);
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#ffee00';
    ctx.shadowColor = '#ff2a00';
    ctx.shadowBlur = 25 + 20 * pulse;
    ctx.stroke();
    ctx.restore();
}

function isClickOnRobber(mouseX, mouseY) {
    if (!isRobberOnBoard()) return false;
    const pixel = hexToPixel(allPlayersData.robber.q, allPlayersData.robber.r, offsetX, offsetY);
    return Math.hypot(mouseX - pixel.x, mouseY - pixel.y) < HEX_SIZE * 0.42;
}

function selectRobberTool() {
    selectedPlayerTool = 'robber';
    document.querySelectorAll('#player-tool-select .btn-tool').forEach(button => button.classList.remove('selected'));
    showMessage('Click a hex to move the robber.');
}

async function undoPlayerLastAction() {
    const undoStack = Array.isArray(allPlayersData._undoStack) ? allPlayersData._undoStack : [];
    if (!isPlayerPage || undoStack.length === 0) {
        showMessage('No actions to undo since the last dice roll.', 'error');
        updateUndoButton();
        return;
    }

    if (undoStack[undoStack.length - 1]?.serverUndo) {
        try {
            const response = await fetch('/catan2/progress_card/undo', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ player_id: PLAYER_ID })
            });
            const result = await response.json();
            if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Could not undo');
            showMessage('Last action undone.');
        } catch (error) {
            showMessage(error.message, 'error');
        }
        return;
    }

    const snapshot = undoStack.pop();
    allPlayersData = JSON.parse(JSON.stringify(snapshot.state));
    allPlayersData._undoStack = undoStack;
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
        const response = await fetch('/catan2/save_board', {
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
        const response = await fetch('/catan2/load_board');
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
            const response = await fetch('/catan2/save_play_state', {
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
    socket.emit('catan2_update');
    console.log('sent signal');

    
    
    
}

async function loadAllPlayerStatesFromBackend() {
    try {
        const response = await fetch('/catan2/load_play_state');
        
        const result = await response.json();
        if (result.status === 'success' && result.play_state) {
            const loadedStates = result.play_state;
            for (const pId in loadedStates) {
                if (pId.startsWith('player') && allPlayersData[pId]) {
                    allPlayersData[pId].playerName = loadedStates[pId].playerName || `Player ${pId.replace('player', '')}`;
                    allPlayersData[pId].hand = (loadedStates[pId].hand || []).map(resource => resource === 'ore' ? 'rock' : resource);
                    allPlayersData[pId].roads = loadedStates[pId].roads || [];
                    allPlayersData[pId].structures = loadedStates[pId].structures || [];
                    allPlayersData[pId].history = loadedStates[pId].history || [];
                    allPlayersData[pId].longestroad = Number(loadedStates[pId].longestroad) || 0;
                    allPlayersData[pId].longestroadmanual = Number(loadedStates[pId].longestroadmanual) || 0;
                    allPlayersData[pId].largestarmy = Number(loadedStates[pId].largestarmy) || 0;
                    allPlayersData[pId].largestarmymanual = Number(loadedStates[pId].largestarmymanual) || 0;
                    allPlayersData[pId].victory_point = Number(loadedStates[pId].victory_point) || 0;
                    allPlayersData[pId].knightplayed = Number(loadedStates[pId].knightplayed) || 0;
                    allPlayersData[pId].citiesAndKnights = normalizeCitiesAndKnightsState(loadedStates[pId].citiesAndKnights);
                }
            }
            allPlayersData['robber']=loadedStates['robber'] || {q:100,r:100};
            allPlayersData.merchant = loadedStates.merchant || { q: 100, r: 100, owner: null };
            allPlayersData._undoStack = Array.isArray(loadedStates._undoStack) ? loadedStates._undoStack.slice(-3) : [];
            allPlayersData._turnOrder = Array.isArray(loadedStates._turnOrder) ? loadedStates._turnOrder : [];
            allPlayersData._currentTurnPlayerId = loadedStates._currentTurnPlayerId || allPlayersData._turnOrder[0] || null;
            allPlayersData._turnRolled = loadedStates._turnRolled === true;
            allPlayersData._gameStarted = loadedStates._gameStarted !== false;
            allPlayersData._turnPhase = loadedStates._turnPhase || null;
            allPlayersData._colorsReady = result.colors_ready !== false;
            allPlayersData._robberMoveAvailable = loadedStates._robberMoveAvailable === true;
            allPlayersData._robberMovePlayerId = loadedStates._robberMovePlayerId || null;
            allPlayersData.lastDiceRoll = loadedStates.lastDiceRoll || null;
            allPlayersData.vpAwardLog = Array.isArray(loadedStates.vpAwardLog) ? loadedStates.vpAwardLog : [];
            allPlayersData.activityLog = Array.isArray(loadedStates.activityLog) ? loadedStates.activityLog : [];
            allPlayersData.metropolisOwners = {
                trade: loadedStates.metropolisOwners?.trade || null,
                politics: loadedStates.metropolisOwners?.politics || null,
                science: loadedStates.metropolisOwners?.science || null
            };
            const savedShipPosition = Number.parseInt(loadedStates.barbarianShipPosition, 10);
            allPlayersData.barbarianShipPosition = Number.isFinite(savedShipPosition)
                ? Math.max(0, Math.min(7, savedShipPosition))
                : 0;
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
            allPlayersData._robberMoveAvailable = false;
            allPlayersData._robberMovePlayerId = null;
        allPlayersData._robberMoveAvailable = false;
        allPlayersData._robberMovePlayerId = null;
        drawBoard();
    }
}
async function loadAllStatesFromBackend() {
    console.log("loading data");
    await loadBoardTilesFromBackend();
    await loadAllPlayerStatesFromBackend();
    updateBarbarianShipPosition();
    updateGameStartUI();
    updateLargestArmyHolder();
    updateLongestRoadHolder();
    if (isGamePage) {
        calculatepointsandcards();
        renderVpAwardLog();
        renderActivityLog();
        renderLastGameDiceRoll();
    }
    //await loadRobberStateFromBackend();
    drawBoard();
}
async function resetgame()
{
    try {
            const response = await fetch('/catan2/reset_game', {

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

function isJunctionOnPlayerRoad(playerId, junction) {
    return (allPlayersData[playerId].roads || []).some(({ edge }) => {
        if (!edge) return false;
        const startId = `${Math.round(edge.x1)},${Math.round(edge.y1)}`;
        const endId = `${Math.round(edge.x2)},${Math.round(edge.y2)}`;
        return startId === junction.id || endId === junction.id;
    });
}

function getTilesAdjacentToJunction(junction) {
    return boardTiles.filter(tile => {
        const rawPixel = hexToRawPixel(tile.q, tile.r);
        return getHexVertices(rawPixel.x, rawPixel.y, TILE_RADIUS).some(vertex =>
            `${Math.round(vertex.x)},${Math.round(vertex.y)}` === junction.id
        );
    });
}

function isRobberAdjacentToJunction(junction) {
    const robber = allPlayersData.robber;
    if (!robber || robber.q === 100 || robber.r === 100) return false;
    return getTilesAdjacentToJunction(junction).some(tile => tile.q === robber.q && tile.r === robber.r);
}

function finishRobberMove(tile) {
    const currentRobber = allPlayersData.robber;
    if (currentRobber && currentRobber.q === tile.q && currentRobber.r === tile.r) {
        showMessage('The robber is already on this tile.', 'info');
        return false;
    }

    savePlayerStateToHistory();
    allPlayersData.robber = tile;
    allPlayersData._robberMoveAvailable = false;
    allPlayersData._robberMovePlayerId = null;
    updateRobberToolAvailability();
    return true;
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

function getClosestEdge(px, py, threshold = 20, middleOnly = false) {
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
        if (middleOnly && (param < 0.25 || param > 0.75)) return;

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
    // Robber moves clear selectedPlayerTool mid-handler, so remember the tool for logging.
    const toolAtClick = selectedPlayerTool;
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

    if (isPlayerPage) {
        const clickedJunction = getClosestJunction(mouseX, mouseY);
        if (selectedRoadToMove) {
            const movingRoad = selectedRoadToMove;
            const targetEdge = getClosestEdge(mouseX, mouseY);
            if (!targetEdge) {
                showMessage('Click near an edge to place the road.', 'error');
                return;
            }
            if (targetEdge.id === movingRoad.edge.id) {
                selectedRoadToMove = null;
                setKnightMenuToolbarLock(false);
                showMessage('Road move cancelled.');
                return;
            }
            const edgeOccupied = Object.keys(allPlayersData).some(playerId =>
                playerId.startsWith('player')
                && (allPlayersData[playerId].roads || []).some(road => road.edge?.id === targetEdge.id)
            );
            if (edgeOccupied) {
                showMessage('A road already occupies that edge.', 'error');
                return;
            }

            savePlayerStateToHistory();
            movingRoad.edge = targetEdge;
            selectedRoadToMove = null;
            diplomatActive = false;
            setKnightMenuToolbarLock(false);
            updateLongestRoadHolder();
            showMessage('Road moved.');
            socket.emit('catan2_game_action_log', { pid: PLAYER_ID, message: 'moved a road' });
            drawBoard();
            updatePlayerUI();
            await saveAllPlayerStatesToBackend();
            return;
        }

        if (selectedKnightToMove) {
            const movingKnight = selectedKnightToMove;
            if (!clickedJunction) {
                showMessage('Click an empty intersection connected to one of your roads.', 'error');
                return;
            }
            if (clickedJunction.id === movingKnight.junction.id) {
                selectedKnightToMove = null;
                setKnightMenuToolbarLock(false);
                showMessage('Knight move cancelled.');
                return;
            }

            const junctionOccupied = Object.keys(allPlayersData).some(playerId =>
                playerId.startsWith('player')
                && (allPlayersData[playerId].structures || []).some(structure => structure.junction.id === clickedJunction.id)
            );
            if (junctionOccupied) {
                showMessage('A knight can only move to an unoccupied intersection.', 'error');
                return;
            }
            if (!isJunctionOnPlayerRoad(PLAYER_ID, clickedJunction)) {
                showMessage('Choose an intersection at the end of one of your roads.', 'error');
                return;
            }

            savePlayerStateToHistory();
            movingKnight.junction = clickedJunction;
            movingKnight.active = false;
            selectedKnightToMove = null;
            setKnightMenuToolbarLock(false);
            showMessage('Knight moved and deactivated.');
            socket.emit('catan2_game_action_log', { pid: PLAYER_ID, message: 'moved and deactivated a knight' });
            drawBoard();
            updatePlayerUI();
            await saveAllPlayerStatesToBackend();
            return;
        }

        if (canPlayerMoveRobber() && selectedPlayerTool !== 'robber' && isClickOnRobber(mouseX, mouseY)) {
            selectedPlayerTool = null;
            document.querySelectorAll('#player-tool-select .btn-tool').forEach(button => button.classList.remove('selected'));
            openBoardPieceActionMenu('robber', allPlayersData.robber);
            return;
        }

        if (selectedPlayerTool === 'inventor') {
            const clickedHex = pixelToHex(mouseX, mouseY, offsetX, offsetY);
            const clickedTile = boardTiles.find(tile => tile.q === clickedHex.q && tile.r === clickedHex.r);
            if (!clickedTile || !Number.isInteger(clickedTile.number)) {
                showMessage('Click a hex with a number token.', 'error');
                return;
            }
            if (INVENTOR_LOCKED_NUMBERS.has(clickedTile.number)) {
                showMessage('2, 6, 8 and 12 cannot be swapped.', 'error');
                return;
            }
            if (!inventorFirstTile || (inventorFirstTile.q === clickedTile.q && inventorFirstTile.r === clickedTile.r)) {
                inventorFirstTile = clickedTile;
                showMessage(`Number ${clickedTile.number} selected. Click a second number to swap with.`);
                return;
            }
            const firstTile = inventorFirstTile;
            inventorFirstTile = null;
            selectedPlayerTool = null;
            drawBoard();
            await swapNumbersWithInventor(firstTile, clickedTile);
            return;
        }

        if (selectedPlayerTool === 'deserter') {
            const player = allPlayersData[PLAYER_ID];
            const levelName = KNIGHT_LEVEL_NAMES[pendingDeserterLevel];
            const junctionOccupied = clickedJunction && Object.keys(allPlayersData).some(playerId =>
                playerId.startsWith('player')
                && (allPlayersData[playerId].structures || []).some(structure => structure.junction.id === clickedJunction.id)
            );
            if (!clickedJunction || junctionOccupied || !isJunctionOnPlayerRoad(PLAYER_ID, clickedJunction)) {
                showMessage('Click an empty intersection connected to your road.', 'error');
                return;
            }
            if (!levelName || updatePlayerKnightLevelCounts(player)[levelName] >= 2) {
                showMessage(`No ${levelName || ''} knight is available to place.`, 'error');
                return;
            }
            savePlayerStateToHistory();
            player.structures.push({ type: 'knight', knightLevel: pendingDeserterLevel, active: false, junction: clickedJunction, owner: PLAYER_ID });
            updatePlayerKnightLevelCounts(player);
            removeOwnProgressCard('deserter');
            selectedPlayerTool = null;
            pendingDeserterLevel = null;
            await finishProgressCardPlay('deserter', `Free ${levelName} knight placed.`, `placed a free ${levelName} knight with Deserter`, `${levelName} knight`);
            return;
        }

        const clickedKnight = clickedJunction
            ? (allPlayersData[PLAYER_ID].structures || []).find(structure =>
                structure.type === 'knight' && structure.junction.id === clickedJunction.id
            )
            : null;
        if (clickedKnight && selectedPlayerTool !== 'merchant') {
            selectedPlayerTool = null;
            document.querySelectorAll('#player-tool-select .btn-tool').forEach(button => {
                button.classList.remove('selected');
            });
            openKnightActionMenu(clickedKnight);
            return;
        }

        const clickedCity = clickedJunction
            ? (allPlayersData[PLAYER_ID].structures || []).find(structure =>
                structure.type === 'city' && structure.junction.id === clickedJunction.id
            )
            : null;
        if (clickedCity && selectedPlayerTool !== 'wall' && selectedPlayerTool !== 'merchant') {
            selectedPlayerTool = null;
            document.querySelectorAll('#player-tool-select .btn-tool').forEach(button => button.classList.remove('selected'));
            openBoardPieceActionMenu('city', clickedCity);
            return;
        }

        const clickedEdge = getClosestEdge(mouseX, mouseY, 10, true);
        const clickedRoad = clickedEdge
            ? (allPlayersData[PLAYER_ID].roads || []).find(road => road.edge?.id === clickedEdge.id)
            : null;
        if (clickedRoad && selectedPlayerTool !== 'merchant') {
            selectedPlayerTool = null;
            document.querySelectorAll('#player-tool-select .btn-tool').forEach(button => button.classList.remove('selected'));
            openBoardPieceActionMenu('road', clickedRoad);
            return;
        }
        if (diplomatActive && clickedEdge && selectedPlayerTool !== 'merchant') {
            const ownerId = Object.keys(allPlayersData).find(playerId =>
                playerId.startsWith('player') && playerId !== PLAYER_ID
                && (allPlayersData[playerId].roads || []).some(road => road.edge?.id === clickedEdge.id)
            );
            if (ownerId) {
                selectedPlayerTool = null;
                document.querySelectorAll('#player-tool-select .btn-tool').forEach(button => button.classList.remove('selected'));
                openBoardPieceActionMenu('opponent-road', allPlayersData[ownerId].roads.find(road => road.edge?.id === clickedEdge.id), ownerId);
                return;
            }
        }
    }

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
        } else if (selectedPlayerTool === 'knight') {
            const clickedJunction = getClosestJunction(mouseX, mouseY);
            if (!clickedJunction) {
                showMessage('Click near an empty road intersection to place a knight.', 'error');
            } else {
                const junctionOccupied = Object.keys(allPlayersData).some(playerId =>
                    playerId.startsWith('player')
                    && (allPlayersData[playerId].structures || []).some(structure => structure.junction.id === clickedJunction.id)
                );
                if (junctionOccupied) {
                    showMessage('A knight must be placed on an empty intersection.', 'error');
                } else if (!isJunctionOnPlayerRoad(PLAYER_ID, clickedJunction)) {
                    showMessage('A knight must be placed at an intersection connected to your road.', 'error');
                } else {
                    const player = allPlayersData[PLAYER_ID];
                    const knightCounts = updatePlayerKnightLevelCounts(player);
                    if (knightCounts.basic >= 2) {
                        showMessage('You have already placed both basic knights.', 'error');
                    } else if (checkAndDeductCards(PLAYER_ID, selectedPlayerTool, true)) {
                        player.structures.push({
                            type: 'knight',
                            knightLevel: 1,
                            active: false,
                            junction: clickedJunction,
                            owner: PLAYER_ID
                        });
                        updatePlayerKnightLevelCounts(player);
                        showMessage('Knight placed.');
                        updatePlayerUI();
                        actionSuccessful = true;
                    }
                }
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
        } else if (selectedPlayerTool === 'wall') {
            const clickedJunction = getClosestJunction(mouseX, mouseY);
            if (clickedJunction) {
                const player = allPlayersData[PLAYER_ID];
                player.citiesAndKnights = normalizeCitiesAndKnightsState(player.citiesAndKnights);
                const city = (player.structures || []).find(structure =>
                    structure.type === 'city' && structure.junction.id === clickedJunction.id
                );
                if (!city) {
                    showMessage('A wall can only be built around one of your cities.', 'error');
                    return;
                }
                if (city.hasWall) {
                    showMessage('This city already has a wall.', 'error');
                    return;
                }
                if (updatePlayerCityWallCount(player) >= 3) {
                    showMessage('You have already built the maximum city walls.', 'error');
                    return;
                }
                if (checkAndDeductCards(PLAYER_ID, selectedPlayerTool, true)) {
                    city.hasWall = true;
                    updatePlayerCityWallCount(player);
                    showMessage('Wall built around your city.');
                    updatePlayerUI();
                    actionSuccessful = true;
                }
            } else {
                showMessage('Click near a junction to build a wall.', 'error');
            }
        } else if (selectedPlayerTool === 'merchant') {
            const clickedHex = pixelToHex(mouseX, mouseY, offsetX, offsetY);
            const clickedTile = boardTiles.find(tile => tile.q === clickedHex.q && tile.r === clickedHex.r);
            const merchantCards = allPlayersData[PLAYER_ID].citiesAndKnights.progressCards;
            const cardIndex = merchantCards.indexOf('merchant');
            if (clickedTile && cardIndex !== -1) {
                savePlayerStateToHistory();
                merchantCards.splice(cardIndex, 1);
                allPlayersData.merchant = {
                    q: clickedTile.q,
                    r: clickedTile.r,
                    owner: PLAYER_ID
                };
                showMessage(`Merchant placed on ${clickedTile.type}.`);
                updatePlayerUI();
                actionSuccessful = true;
            } else if (cardIndex === -1) {
                selectedPlayerTool = null;
                showMessage('Merchant card is no longer in your hand.', 'error');
            } else {
                showMessage('Click a hex to place the Merchant.', 'error');
            }
        } else if (selectedPlayerTool === 'robber') {
            if (!canPlayerMoveRobber()) {
                showMessage('The robber can be moved after you roll a 7 or use an active knight to attack.', 'error');
                return;
            }
            const clickedHex = pixelToHex(mouseX, mouseY, offsetX, offsetY);
            const clickedTile = boardTiles.find(t => t.q === clickedHex.q && t.r === clickedHex.r);
            if (clickedTile) {
                if (finishRobberMove(clickedTile)) {
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
                wall: 'built a wall',
                knight: 'placed a knight',
                merchant: 'played merchant',
                robber: 'moved the robber'
            };
            if (actionMessages[toolAtClick]) {
                socket.emit('catan2_game_action_log', { pid: PLAYER_ID, message: actionMessages[toolAtClick] });
            }
            if (toolAtClick === 'merchant') {
                const merchantTile = boardTiles.find(tile => tile.q === allPlayersData.merchant?.q && tile.r === allPlayersData.merchant?.r);
                socket.emit('catan2_progress_card_played', { pid: PLAYER_ID, card: 'merchant', target: merchantTile?.type || null });
            }
            if (toolAtClick === 'robber' || toolAtClick === 'merchant') {
                selectedPlayerTool = null;
            }
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
    const boardPieceActionModal = document.getElementById('boardPieceActionModal');
    boardPieceActionModal.addEventListener('click', async event => {
        if (event.target.closest('#cancelBoardPieceAction') || event.target === boardPieceActionModal) {
            closeBoardPieceActionMenu();
            return;
        }
        const actionButton = event.target.closest('[data-board-piece-action]');
        if (!actionButton) return;
        await applyBoardPieceAction(actionButton.dataset.boardPieceAction);
    });

    const knightActionModal = document.getElementById('knightActionModal');
    knightActionModal.addEventListener('click', async event => {
        if (event.target.id === 'cancelKnightAction' || event.target === knightActionModal) {
            knightActionModal.classList.add('hidden');
            selectedKnightActionTarget = null;
            setKnightMenuToolbarLock(false);
            return;
        }

        const actionButton = event.target.closest('[data-knight-action]');
        if (!actionButton || actionButton.disabled) return;
        if (actionButton.dataset.knightAction === 'attack') {
            const attackingKnight = selectedKnightActionTarget;
            if (!attackingKnight?.active || !isRobberAdjacentToJunction(attackingKnight.junction)) return;
            savePlayerStateToHistory();
            attackingKnight.active = false;
            allPlayersData._robberMoveAvailable = true;
            allPlayersData._robberMovePlayerId = PLAYER_ID;
            selectedKnightActionTarget = null;
            knightActionModal.classList.add('hidden');
            setKnightMenuToolbarLock(false);
            showMessage('Attack ready. Select the Robber tool, then click a hex to move the robber.');
            socket.emit('catan2_game_action_log', { pid: PLAYER_ID, message: 'used a knight attack to enable moving the robber' });
            drawBoard();
            updatePlayerUI();
            await saveAllPlayerStatesToBackend();
            return;
        }
        if (actionButton.dataset.knightAction === 'move') {
            if (!selectedKnightActionTarget?.active) return;
            selectedKnightToMove = selectedKnightActionTarget;
            selectedKnightActionTarget = null;
            knightActionModal.classList.add('hidden');
            showMessage('Click an empty intersection at the end of one of your roads. Press Escape to cancel.');
            return;
        }
        await applyKnightAction(actionButton.dataset.knightAction);
    });

    window.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        if (selectedPlayerTool === 'inventor' || selectedPlayerTool === 'deserter') {
            selectedPlayerTool = null;
            inventorFirstTile = null;
            pendingDeserterLevel = null;
            drawBoard();
            showMessage('Progress card cancelled. The card stays in your hand.');
            return;
        }
        if (selectedRoadToMove) {
            selectedRoadToMove = null;
            setKnightMenuToolbarLock(false);
            showMessage('Road move cancelled.');
            return;
        }
        if (!selectedKnightToMove) return;
        selectedKnightToMove = null;
        setKnightMenuToolbarLock(false);
        showMessage('Knight action cancelled.');
    });

    document.getElementById('player-tool-select').addEventListener('click', (event) => {
        const target = event.target.closest('.btn-tool');
        if (!target) return;

        const toolbarButtons = document.querySelectorAll('#player-tool-select .btn-tool');
        const toolMessages = {
            house: 'Place a settlement',
            city: 'Upgrade to city',
            road: 'Place a road',
            wall: 'Build city wall',
            knight: 'Place a knight',
            robber: 'Move robber and steal'
        };

        if (target.classList.contains('selected')) {
            if (messageBox.querySelector('span')?.textContent === toolMessages[selectedPlayerTool]) {
                dismissPlayerMessage();
            }
            target.classList.remove('selected');
            selectedPlayerTool = null;
            return;
        }

        toolbarButtons.forEach(btn => btn.classList.remove('selected'));
        target.classList.add('selected');
        selectedPlayerTool = target.dataset.tool;
        if (toolMessages[selectedPlayerTool]) showMessage(toolMessages[selectedPlayerTool]);
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

    const progressCardButton = document.getElementById('progressCardButton');
    const progressCardModal = document.getElementById('progressCardModal');
    const discardProgressCardModal = document.getElementById('discardProgressCardModal');
    const discardProgressCardList = document.getElementById('discardProgressCardList');

    document.querySelectorAll('[data-progress-book]').forEach(bookButton => {
        bookButton.addEventListener('click', () => openProgressBookActionMenu(bookButton.dataset.progressBook));
    });
    const progressBookActionModal = document.getElementById('progressBookActionModal');
    progressBookActionModal.addEventListener('click', event => {
        if (event.target === progressBookActionModal || event.target.closest('#cancelProgressBookUpgrade')) {
            closeProgressBookActionMenu();
        }
    });
    document.getElementById('confirmProgressBookUpgrade').addEventListener('click', async () => {
        const track = selectedProgressBookTrack;
        closeProgressBookActionMenu();
        if (track) await upgradeProgressBook(track);
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !progressBookActionModal.classList.contains('hidden')) {
            closeProgressBookActionMenu();
        }
    });

    function openProgressCardDeckChoices() {
        progressCardModal.classList.remove('hidden');
    }

    function openProgressCardDiscardChoices() {
        const progressCards = allPlayersData[PLAYER_ID].citiesAndKnights.progressCards;
        discardProgressCardList.replaceChildren();
        progressCards.forEach((_, index) => {
            const discardButton = document.createElement('button');
            discardButton.type = 'button';
            discardButton.className = 'c2-progress-discard-choice';

            const cardName = progressCards[index] || 'progress';
            const cardLabel = document.createElement('span');
            cardLabel.className = 'c2-discard-card-label';
            cardLabel.textContent = `Discard ${cardName.replaceAll('_', ' ')}`;

            discardButton.style.backgroundImage = `url('${resolveProgressCardImageUrl(cardName)}')`;
            discardButton.appendChild(cardLabel);
            discardButton.addEventListener('click', async () => {
                savePlayerStateToHistory();
                progressCards.splice(index, 1);
                allPlayersData[PLAYER_ID].citiesAndKnights.pendingProgressReplacement = true;
                allPlayersData[PLAYER_ID].citiesAndKnights.pendingDiscardedProgressCard = cardName;
                discardProgressCardModal.classList.add('hidden');
                updatePlayerUI();
                await saveAllPlayerStatesToBackend();
                openProgressCardDeckChoices();
                showMessage('Progress card discarded. Choose a deck to draw from.');
            });
            discardProgressCardList.appendChild(discardButton);
        });
        discardProgressCardModal.classList.remove('hidden');
    }

    progressCardButton.addEventListener('click', () => {
        const progressCards = allPlayersData[PLAYER_ID].citiesAndKnights.progressCards;
        if (progressCards.length >= 5) {
            openProgressCardDiscardChoices();
            return;
        }
        openProgressCardDeckChoices();
    });

    document.querySelectorAll('[data-progress-track]').forEach(deckButton => {
        deckButton.addEventListener('click', async () => {
            const track = deckButton.dataset.progressTrack;
            if (!['trade', 'politics', 'science'].includes(track)) return;

            const progressCards = allPlayersData[PLAYER_ID].citiesAndKnights.progressCards;
            if (progressCards.length >= 5) {
                progressCardModal.classList.add('hidden');
                openProgressCardDiscardChoices();
                return;
            }

            progressCardModal.classList.add('hidden');
            const response = await fetch('/catan2/progress_card/draw', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ player_id: PLAYER_ID, deck: track })
            });
            const result = await response.json();
            if (!response.ok) {
                showMessage(result.message || 'Could not draw a progress card.', 'error');
                return;
            }

            await loadAllPlayerStatesFromBackend();
            updatePlayerUI();
            showMessage(`Drew a ${track[0].toUpperCase()}${track.slice(1)} progress card.`);
        });
    });

    document.getElementById('cancelProgressCardChoice').addEventListener('click', async () => {
        progressCardModal.classList.add('hidden');
        const state = allPlayersData[PLAYER_ID].citiesAndKnights;
        if (state.pendingProgressReplacement) {
            const discardedName = state.pendingDiscardedProgressCard?.replaceAll('_', ' ') || 'a Progress card';
            state.pendingProgressReplacement = false;
            state.pendingDiscardedProgressCard = null;
            await saveAllPlayerStatesToBackend();
            socket.emit('catan2_game_action_log', { pid: PLAYER_ID, message: `dropped ${discardedName}` });
        }
    });
    document.getElementById('cancelProgressCardDiscard').addEventListener('click', () => {
        discardProgressCardModal.classList.add('hidden');
    });
    document.querySelector('.player-decks-section').addEventListener('click', async (event) => {
        const target = event.target.closest('button');
        if (!target || target.disabled) return;
        if (target.dataset.handAction === 'drop') {
            await transferOrDropSelectedCards(PLAYER_ID, 'NA');
            return;
        }
        if (target.dataset.handAction === 'clear') {
            clearResourceSelection('drop');
            return;
        }
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
        if (/^player/i.test(String(allPlayersData[pId].playerName || '').trim())) {
            button.disabled = true;
            button.title = 'Inactive seat';
        }
        transferDropButtonsDiv.appendChild(button);
    });

    [{ action: 'drop', label: 'Drop' }, { action: 'clear', label: 'Clear' }].forEach(({ action, label }) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.classList.add('btn', 'btn-tool', 'hand-selection-btn', `hand-selection-${action}`);
        button.dataset.handAction = action;
        button.textContent = label;
        transferDropButtonsDiv.appendChild(button);
    });
    updateHandSelectionButtons();
}

function updateHandSelectionButtons() {
    const count = selectedHandCards.length;
    const handCount = allPlayersData[PLAYER_ID]?.hand?.length || 0;
    document.querySelectorAll('[data-hand-action]').forEach(button => {
        button.disabled = count === 0;
        button.title = button.dataset.handAction === 'drop'
            ? (count ? `Drop ${count}/${handCount} selected card${count === 1 ? '' : 's'}` : 'Select hand cards to drop')
            : 'Clear hand selection';
    });
    const dropButton = document.querySelector('[data-hand-action="drop"]');
    if (dropButton) dropButton.textContent = count ? `Drop ${count}` : 'Drop';
}
function resizeCanvas() {
    if (isGamePage && canvas.parentElement.clientWidth === 0) return;
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

        const resourceTypes = ['wood', 'sheep', 'rock', 'brick', 'hay', 'paper', 'cloth', 'coin'];
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

        renderTransferDropButtons();
        updateUndoButton();
        updateRollButton();
        updateRobberToolAvailability();
        updateCitiesAndKnightsTracker();
        
}

function resolveProgressCardImageUrl(cardName) {
    const card = String(cardName || '').trim();
    if (!card) return '/static/images/catan/dev_card.jpg';

    const exactKnownMatches = {
        merchant: 'merchant.jpg',
        merchant_fleet: 'merchantfleet.jpg',
        master_merchant: 'merchant.jpg',
        trade_monopoly: 'trademonopoly.jpg',
        resource_monopoly: 'resourcemonopoly.jpg',
        bishop: 'bishop.jpg',
        diplomat: 'diplomat.jpg',
        intrigue: 'intrigue.jpg',
        saboteur: 'sabotour.jpg',
        spy: 'dev_card.jpg',
        deserter: 'deserter.jpg',
        victory_point: 'victory_point.jpg',
        printer: 'printer.jpg',
        constitution: 'constitution.jpg',
        alchemist: 'alchemist.jpg',
        crane: 'crane.jpg',
        mining: 'mining.jpg',
        irrigation: 'irrigation.jpg',
        inventor: 'inventor.jpg',
        engineer: 'engineer.jpg',
        medicine: 'medicine.jpg',
        smith: 'smith.jpg',
        road_building: 'roadbuilding.jpg',
        harbor: 'dev_card.jpg',
        warlord: 'dev_card.jpg',
        wedding: 'wedding.jpg',
        progress: 'dev_card.jpg'
    };

    const exactMatch = exactKnownMatches[card];
    if (exactMatch) return `/static/images/catan/${exactMatch}`;

    const fallback = `${card}.jpg`;
    return `/static/images/catan/${fallback}`;
}

function updateCitiesAndKnightsTracker() {
    if (!isPlayerPage || !allPlayersData[PLAYER_ID]) return;
    const player = allPlayersData[PLAYER_ID];
    player.citiesAndKnights = normalizeCitiesAndKnightsState(player.citiesAndKnights);
    const state = player.citiesAndKnights;

    ['trade', 'politics', 'science'].forEach(track => {
        const marker = document.querySelector(`[data-metropolis-marker="${track}"]`);
        if (marker) {
            const ownerId = allPlayersData.metropolisOwners?.[track];
            marker.classList.toggle('is-owned', ownerId === PLAYER_ID);
            marker.setAttribute('aria-label', `${track} metropolis ${ownerId === PLAYER_ID ? 'owned by you' : ownerId ? `owned by ${allPlayersData[ownerId]?.playerName || ownerId}` : 'unowned'}`);
            marker.title = marker.getAttribute('aria-label');
        }
        const improvementOutput = document.querySelector(`[data-c2-value="improvements:${track}"]`);
        if (improvementOutput) improvementOutput.textContent = Math.min(5, state.improvements[track]);
        const deckCount = document.querySelector(`[data-progress-deck-count="${track}"]`);
        if (deckCount) deckCount.textContent = state.progressCards.length;

        const bookButton = document.querySelector(`[data-progress-book="${track}"]`);
        if (bookButton) {
            const level = state.improvements[track];
            const bookLevel = Math.min(5, level);
            const image = bookButton.querySelector('[data-progress-book-image]');
            const placeholder = bookButton.querySelector('[data-progress-book-placeholder]');

            bookButton.title = level >= 5
                ? `${track} progress at maximum level`
                : `Upgrade ${track} progress`;

            if (image.dataset.level !== String(bookLevel)) {
                image.dataset.level = String(bookLevel);
                image.hidden = true;
                placeholder.hidden = false;
                image.onload = () => {
                    if (image.dataset.level !== String(bookLevel)) return;
                    image.hidden = false;
                    placeholder.hidden = true;
                };
                image.onerror = () => {
                    if (image.dataset.level === String(bookLevel)) {
                        image.hidden = true;
                        placeholder.hidden = false;
                    }
                };
                image.src = `/static/images/catan/progressbook/${track}${bookLevel || ''}.png`;
            }
        }
    });
    ['basic', 'strong', 'mighty'].forEach(strength => {
        const output = document.querySelector(`[data-c2-value="knights:${strength}"]`);
        if (output) output.textContent = state.knights[strength];
    });
    const wallsOutput = document.querySelector('[data-c2-value="cityWalls"]');
    if (wallsOutput) wallsOutput.textContent = state.cityWalls;
    const metropolisSelect = document.querySelector('[data-c2-metropolis]');
    if (metropolisSelect) metropolisSelect.value = state.metropolis;

    const progressCardsContainer = document.getElementById('progressCards');
    if (progressCardsContainer) {
        progressCardsContainer.replaceChildren();
        state.progressCards.forEach((progressCard, index) => {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'c2-progress-card dev-card';
            card.dataset.resourceType = 'development';
            const cardName = progressCard === 'progress' ? 'progress' : progressCard;
            const imageUrl = resolveProgressCardImageUrl(cardName);
            card.style.backgroundImage = `url('${imageUrl}')`;
            card.style.backgroundSize = 'cover';
            card.style.backgroundRepeat = 'no-repeat';
            card.style.backgroundPosition = 'center';
            card.setAttribute('aria-label', `Progress card: ${progressCard === 'progress' ? `Progress Card ${index + 1}` : progressCard.replaceAll('_', ' ')}`);
            card.title = progressCard === 'progress'
                ? `Progress Card ${index + 1}`
                : progressCard.replaceAll('_', ' ');
            card.addEventListener('click', () => activateProgressCard(index));
            progressCardsContainer.appendChild(card);
        });
        for (let slot = state.progressCards.length; slot < 5; slot++) {
            const placeholder = document.createElement('div');
            placeholder.className = 'c2-progress-card c2-progress-card-empty';
            placeholder.setAttribute('aria-hidden', 'true');
            progressCardsContainer.appendChild(placeholder);
        }
    }
    const progressCardCount = document.getElementById('progressCardCount');
    if (progressCardCount) progressCardCount.textContent = `${state.progressCards.length}/5`;
}

async function activateProgressCard(cardIndex) {
    const player = allPlayersData[PLAYER_ID];
    const progressCards = player?.citiesAndKnights?.progressCards;
    const cardName = progressCards?.[cardIndex];
    if (!cardName) return;

    const config = getProgressCardActionConfig(cardName);
    const confirmation = await showProgressCardActionModal(config, cardName);
    if (!confirmation.confirmed || config.unavailable) return;

    if (['merchant', 'deserter', 'inventor'].includes(cardName) && (selectedRoadToMove || selectedKnightToMove)) {
        showMessage('Finish moving your road or knight first.', 'error');
        return;
    }
    if (cardName === 'merchant') {
        selectProgressCardBoardTool('merchant', 'Click a hex to place the Merchant.');
        return;
    }

    const handler = PROGRESS_CARD_ACTION_HANDLERS[cardName];
    if (handler) {
        await handler({ cardName, choice: confirmation.choice });
        return;
    }
    await playSimpleProgressCard(cardName, 'Resolve its effect manually.');
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
    // Hand (drop) selections use the Drop/Clear buttons beside the transfer buttons instead of the tray.
    tray.hidden = mode === 'drop' || selectedResources.length === 0;
    updateHandSelectionButtons();
    total.textContent = mode === 'drop'
        ? `${selectedResources.length}/${allPlayersData[PLAYER_ID].hand.length} card${selectedResources.length === 1 ? '' : 's'} staged to drop`
        : `${selectedResources.length} card${selectedResources.length === 1 ? '' : 's'} selected`;
    details.textContent = Object.entries(counts)
        .sort(([first], [second]) => ['wood', 'paper', 'sheep', 'cloth', 'rock', 'coin', 'brick', 'hay'].indexOf(first) - ['wood', 'paper', 'sheep', 'cloth', 'rock', 'coin', 'brick', 'hay'].indexOf(second))
        .map(([resourceType, count]) => `${count}${({ wood: 'W', brick: 'B', rock: 'R', sheep: 'S', hay: 'H', coin: 'C', paper: 'P', cloth: 'L' })[resourceType] || resourceType[0].toUpperCase()}`)
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

function clearResourceSelection(forcedMode) {
    const tray = document.getElementById('resourceSelectionTray');
    const mode = typeof forcedMode === 'string' ? forcedMode : tray.dataset.mode || 'take';
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
    socket.emit('catan2_card_pick_log', {
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
    const resourceTypes = ['wood', 'brick', 'rock', 'sheep', 'hay', 'paper', 'cloth', 'coin'];
    const cardSummary = resourceTypes
        .filter(type => cardCounts[type])
        .map(type => `${cardCounts[type]} ${type[0].toUpperCase()}${type.slice(1)}`)
        .join(', ');
    const actionMessage = targetPlayerId === 'NA'
        ? `dropped ${cardSummary}`
        : `gave ${cardSummary} to ${allPlayersData[targetPlayerId].playerName}`;
    socket.emit('catan2_game_action_log', { pid: currentPlayerId, message: actionMessage });
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
        socket.emit('catan2_game_action_log', {
            pid: currentPlayerId,
            message: `stole from ${allPlayersData[targetPlayerId].playerName}`
        });
    }
    updatePlayerUI(); 
    showMessage('Card steal completed.');
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

const CITIES_AND_KNIGHTS_EVENT_DIE = [
    'green_city', 'yellow_city', 'blue_city',
    'black_ship', 'black_ship', 'black_ship'
];

function getRandomCitiesAndKnightsEventFace() {
    return CITIES_AND_KNIGHTS_EVENT_DIE[getRandomInt(0, CITIES_AND_KNIGHTS_EVENT_DIE.length - 1)];
}

function getDiceFaceHTML(value, color) {
    return `<div class="dice-face dice-${color}" role="img" aria-label="${color} die showing ${value}">${getDicePipHTML(value)}</div>`;
}

const CITIES_AND_KNIGHTS_EVENT_FACE_ASSETS = {
    green_city: { label: 'Green city', image: 'diceg.png' },
    yellow_city: { label: 'Yellow city', image: 'dicey.png' },
    blue_city: { label: 'Blue city', image: 'diceb.png' },
    black_ship: { label: 'Black ship', image: 'dices.png' }
};

function getEventDieFaceHTML(eventFace) {
    const face = CITIES_AND_KNIGHTS_EVENT_FACE_ASSETS[eventFace] || CITIES_AND_KNIGHTS_EVENT_FACE_ASSETS.black_ship;
    const faceType = CITIES_AND_KNIGHTS_EVENT_FACE_ASSETS[eventFace] ? eventFace : 'black_ship';
    return `<div class="catan2-event-die-face event-${faceType}" role="img" aria-label="${face.label}"><img src="/static/images/catan/${face.image}" alt=""></div>`;
}

function setDiceFaceValue(face, value) {
    face.setAttribute('aria-label', `Die showing ${value}`);
    face.innerHTML = getDicePipHTML(value);
}

function setEventDieFace(element, eventFace) {
    const face = CITIES_AND_KNIGHTS_EVENT_FACE_ASSETS[eventFace] || CITIES_AND_KNIGHTS_EVENT_FACE_ASSETS.black_ship;
    const faceType = CITIES_AND_KNIGHTS_EVENT_FACE_ASSETS[eventFace] ? eventFace : 'black_ship';
    element.className = `catan2-event-die-face event-${faceType}`;
    element.setAttribute('aria-label', face.label);
    element.innerHTML = `<img src="/static/images/catan/${face.image}" alt="">`;
}

function renderGameDiceResult(dice, eventFace) {
    const displayElement = document.getElementById('diceroll');
    if (!displayElement) return;
    displayElement.innerHTML = `<div class="dice-result" aria-live="polite">${getDiceFaceHTML(dice[0], 'red')}${getDiceFaceHTML(dice[1], 'yellow')}${getEventDieFaceHTML(eventFace)}</div>`;
    displayElement.classList.remove('rolling');
    displayElement.classList.add('final-roll');
}

function renderLastGameDiceRoll() {
    const lastRoll = allPlayersData.lastDiceRoll;
    if (Array.isArray(lastRoll?.dice) && lastRoll.dice.length === 2
        && lastRoll.dice.every(value => Number.isInteger(value) && value >= 1 && value <= 6)
        && CITIES_AND_KNIGHTS_EVENT_DIE.includes(lastRoll.event_die)) {
        renderGameDiceResult(lastRoll.dice, lastRoll.event_die);
    } else {
        const displayElement = document.getElementById('diceroll');
        if (displayElement) displayElement.replaceChildren();
    }
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
    overlay.innerHTML = '<div class="dice-roll-panel"><span class="dice-roll-caption">Rolling Cities &amp; Knights dice</span><div class="dice-overlay-dice"><div class="dice-face dice-red" role="img" aria-label="Red die"></div><div class="dice-face dice-yellow" role="img" aria-label="Yellow die"></div><div class="catan2-event-die-face event-black_ship" role="img" aria-label="Event die"></div></div></div>';
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

function showSharedDiceRoll(finalDice, finalEventFace, fixedNumberDice = false) {
    if (diceAnimationInterval) window.clearInterval(diceAnimationInterval);
    if (diceAnimationTimeout) window.clearTimeout(diceAnimationTimeout);
    if (diceOverlayHideTimeout) window.clearTimeout(diceOverlayHideTimeout);

    const overlay = getDiceRollOverlay();
    const faces = overlay.querySelectorAll('.dice-face');
    const eventDie = overlay.querySelector('.catan2-event-die-face');
    const caption = overlay.querySelector('.dice-roll-caption');
    overlay.hidden = false;
    overlay.classList.remove('is-result');
    overlay.classList.add('is-visible', 'is-rolling');
    caption.textContent = fixedNumberDice ? 'Alchemist roll' : 'Rolling dice';

    const randomizeFaces = () => {
        faces.forEach((face, index) => setDiceFaceValue(face, fixedNumberDice ? finalDice[index] : getRandomInt(1, 6)));
        setEventDieFace(eventDie, getRandomCitiesAndKnightsEventFace());
    };
    randomizeFaces();
    diceAnimationInterval = window.setInterval(randomizeFaces, 115);

    diceAnimationTimeout = window.setTimeout(() => {
        window.clearInterval(diceAnimationInterval);
        diceAnimationInterval = null;
        faces.forEach((face, index) => setDiceFaceValue(face, finalDice[index]));
        setEventDieFace(eventDie, finalEventFace);
        caption.textContent = 'Roll result · click to dismiss';
        overlay.classList.remove('is-rolling');
        overlay.classList.add('is-result');

        renderGameDiceResult(finalDice, finalEventFace);

        diceOverlayHideTimeout = window.setTimeout(() => {
            overlay.classList.remove('is-visible', 'is-result');
            overlay.hidden = true;
        }, 5000);
    }, 1500);
}


function rolldice()
{
    if (!isPlayerPage || turnRequestPending || allPlayersData._currentTurnPlayerId !== PLAYER_ID || allPlayersData._turnRolled === true) {
        updateRollButton();
        return;
    }
    showMessage('Rolling dice...');
    markTurnRequestPending();
    socket.emit('catan2_roll_dice', { player_id: PLAYER_ID });

}

let turnRequestTimeout = null;

function markTurnRequestPending() {
    turnRequestPending = true;
    window.clearTimeout(turnRequestTimeout);
    // Release the button if the server never answers (e.g. dropped connection).
    turnRequestTimeout = window.setTimeout(clearTurnRequestPending, 8000);
    updateRollButton();
}

function clearTurnRequestPending() {
    turnRequestPending = false;
    window.clearTimeout(turnRequestTimeout);
    turnRequestTimeout = null;
    updateRollButton();
}
socket.on('catan2_undo_history_reset', () => {
    allPlayersData._undoStack = [];
    updateUndoButton();
});

socket.on('catan2_board_edit_state', data => {
    boardEditingAllowed = data?.editable === true;
    if (boardEditingAllowed && builderHistoryStack.length === 0) saveBuilderState();
    if (!boardEditingAllowed) builderHistoryStack = [];
    updateBoardEditingUI();
});

socket.on('catan2_roll_rejected', data => {
    if (data.current_player) allPlayersData._currentTurnPlayerId = data.current_player;
    allPlayersData._turnRolled = data.turn_rolled === true;
    clearTurnRequestPending();
    showMessage(data.message || 'It is not your turn to roll.', 'error');
});

socket.on('catan2_end_turn_rejected', data => {
    if (data.current_player) allPlayersData._currentTurnPlayerId = data.current_player;
    allPlayersData._turnRolled = data.turn_rolled === true;
    clearTurnRequestPending();
    showMessage(data.message || 'You cannot end the turn right now.', 'error');
});

socket.on('catan2_turn_ended_broadcast', data => {
    allPlayersData._currentTurnPlayerId = data?.current_player || null;
    allPlayersData._turnRolled = data?.turn_rolled === true;
    allPlayersData._turnPhase = data?.phase || allPlayersData._turnPhase;
    allPlayersData._robberMoveAvailable = false;
    allPlayersData._robberMovePlayerId = null;
    clearTurnRequestPending();
    updateRobberToolAvailability();
    renderGameScoreboard();
    if (isPlayerPage && data?.current_player === PLAYER_ID) {
        showMessage(allPlayersData._turnPhase === 'setup'
            ? 'Your setup turn. Place your pieces, then tap the tick.'
            : 'Your turn. Roll the dice.');
    } else if (isPlayerPage && data?.previous_player === PLAYER_ID) {
        showMessage(`Turn passed to ${allPlayersData[data.current_player]?.playerName || 'the next player'}.`);
    }
});

socket.on('catan2_roll_dice_broadcast', (data) => {
    const dice = Array.isArray(data?.dice) && data.dice.length === 2
        && data.dice.every(value => Number.isInteger(value) && value >= 1 && value <= 6)
        ? data.dice
        : [getRandomInt(1, 6), getRandomInt(1, 6)];
    const eventFace = CITIES_AND_KNIGHTS_EVENT_DIE.includes(data?.event_die)
        ? data.event_die
        : getRandomCitiesAndKnightsEventFace();
    if (data.current_player) allPlayersData._currentTurnPlayerId = data.current_player;
    allPlayersData._turnRolled = true;
    allPlayersData._robberMoveAvailable = data?.robber_move_available === true;
    allPlayersData._robberMovePlayerId = data?.robber_move_player || null;
    allPlayersData.lastDiceRoll = { dice, event_die: eventFace };
    clearTurnRequestPending();
    updateRobberToolAvailability();
    renderGameScoreboard();
    showSharedDiceRoll(dice, eventFace, data?.alchemist === true);
});

let progressCardPopupTimeout = null;

function hideProgressCardPopup() {
    const popup = document.getElementById('progressCardPopup');
    if (popup) popup.hidden = true;
    window.clearTimeout(progressCardPopupTimeout);
    progressCardPopupTimeout = null;
}

socket.on('catan2_progress_card_played_broadcast', data => {
    const popup = document.getElementById('progressCardPopup');
    if (!isGamePage || !popup || typeof data?.card !== 'string') return;
    const cardLabel = data.card.replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase());
    const playerName = allPlayersData[data.pid]?.playerName || data.pid;
    document.getElementById('progressCardPopupPlayer').textContent = data.target ? `${playerName} > ${data.target}` : playerName;
    document.getElementById('progressCardPopupName').textContent = cardLabel;
    const image = document.getElementById('progressCardPopupImage');
    image.src = resolveProgressCardImageUrl(data.card);
    image.alt = cardLabel;
    popup.hidden = false;
    window.clearTimeout(progressCardPopupTimeout);
    progressCardPopupTimeout = window.setTimeout(hideProgressCardPopup, 15000);
});

if (isGamePage) {
    document.addEventListener('click', hideProgressCardPopup, true);
}


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


function renderVpAwardLog() {
    const log = document.getElementById('vpAwardLog');
    if (!log) return;
    log.replaceChildren();
    const awards = Array.isArray(allPlayersData.vpAwardLog) ? allPlayersData.vpAwardLog : [];
    if (awards.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'c2-vp-log-empty';
        empty.textContent = 'No awards yet.';
        log.appendChild(empty);
        return;
    }
    awards.slice().reverse().forEach(award => {
        const item = document.createElement('li');
        const description = document.createElement('span');
        description.textContent = award.type === 'metropolis'
            ? `${award.track} Metrop > ${award.playerName}`
            : award.type === 'title'
                ? `${award.title} > ${award.playerName}`
                : award.type === 'progress_vp'
                    ? `${award.playerName} > (VP) ${award.card}`
                    : `Victory Point > ${award.playerName}`;
        item.appendChild(description);
        log.appendChild(item);
    });
}

function renderActivityLog() {
    const log = document.getElementById('activityLog');
    if (!log) return;
    log.replaceChildren();
    const entries = Array.isArray(allPlayersData.activityLog) ? allPlayersData.activityLog : [];
    if (entries.length === 0) {
        const empty = document.createElement('li');
        empty.textContent = 'No activity yet.';
        log.appendChild(empty);
        return;
    }
    entries.slice().reverse().forEach(entry => {
        const item = document.createElement('li');
        item.textContent = `${entry.player || 'Player'} ${entry.message || ''}`.trim();
        item.title = item.textContent;
        item.dataset.kind = entry.kind || 'action';
        log.appendChild(item);
    });
}

function getPlayerVictoryPoints(player) {
    return (Number(player.victory_point) || 0) + (player.citiesAndKnights?.progressCards || []).filter(card =>
        ['victory_point', 'printer', 'constitution'].includes(card)
    ).length;
}

function getPlayerMetropolisCount(playerId) {
    return ['trade', 'politics', 'science'].filter(track =>
        allPlayersData.metropolisOwners?.[track] === playerId
    ).length;
}

function renderGameScoreboard() {
    if (!isGamePage) return;

    const seatPlayerIds = ['player1', 'player2', 'player3', 'player4'];
    const registeredOrder = Array.isArray(allPlayersData._turnOrder)
        ? allPlayersData._turnOrder.filter(playerId => seatPlayerIds.includes(playerId))
        : [];
    const playerIds = [...new Set([...registeredOrder, ...seatPlayerIds])];
    const scoreboardBody = document.querySelector('#assignpoint table tbody');
    const highestScore = Math.max(0, ...playerIds.map(playerId => Number(allPlayersData[playerId]?.score) || 0));

    playerIds.forEach(playerId => {
        const player = allPlayersData[playerId];
        const row = scoreboardBody.querySelector(`[data-player-id="${playerId}"]`);
        if (!row) return;

        row.classList.toggle('c2-score-leader', highestScore > 0 && Number(player.score) === highestScore);
        row.classList.toggle('c2-score-inactive', /^player/i.test(String(player.playerName || '').trim()));
        row.classList.toggle('c2-score-active', playerId === allPlayersData._currentTurnPlayerId);
        row.cells[0].textContent = player.playerName;
        row.cells[1].textContent = player.score;
        row.cells[2].textContent = `${player.hand.length}-${(player.citiesAndKnights?.progressCards || []).length}`;
        const improvements = player.citiesAndKnights?.improvements || {};
        row.cells[3].textContent = (player.structures || []).reduce((total, structure) =>
            total + (structure.type === 'knight' && structure.active === true
                ? Math.max(1, Math.min(3, Number(structure.knightLevel) || 1)) : 0), 0);
        row.cells[4].textContent = getPlayerVictoryPoints(player);
        row.cells[5].textContent = getPlayerMetropolisCount(playerId);
        row.cells[6].textContent = ['trade', 'politics', 'science'].map(track =>
            Math.min(5, Math.max(0, Number(improvements[track]) || 0))
        ).join('-');
        scoreboardBody.appendChild(row);

        const awardButton = document.querySelector(`[data-award-vp="${playerId}"]`);
        if (awardButton) awardButton.textContent = player.playerName;
        const metropolisButton = document.querySelector(`[data-metropolis-player="${playerId}"]`);
        if (metropolisButton) metropolisButton.textContent = player.playerName;
        const titleButton = document.querySelector(`[data-title-player="${playerId}"]`);
        if (titleButton) titleButton.textContent = player.playerName;
    });
}

function calculatepointsandcards() {
    for (const playerId in allPlayersData) {
        if (!playerId.startsWith('player')) continue;

        const player = allPlayersData[playerId];
        let score = player.longestroad ? 2 : 0;
        const structurePoints = new Map();
        for (const structure of player.structures || []) {
            const points = structure.type === 'city' ? 2 : structure.type === 'house' ? 1 : 0;
            if (points === 0) continue;
            const junctionId = structure.junction.id;
            structurePoints.set(junctionId, Math.max(structurePoints.get(junctionId) || 0, points));
        }
        score += [...structurePoints.values()].reduce((total, points) => total + points, 0);
        score += getPlayerVictoryPoints(player);
        score += getPlayerMetropolisCount(playerId) * 2;
        if (allPlayersData.merchant?.owner === playerId
            && allPlayersData.merchant.q !== 100 && allPlayersData.merchant.r !== 100) {
            score += 1;
        }
        player.score = score;
    }

    renderGameScoreboard();
    socket.emit('catan2_score_update');
}

const awardVpButton = document.getElementById('awardVpButton');
const awardVpModal = document.getElementById('awardVpModal');
const awardVpChoices = document.getElementById('awardVpChoices');
if (awardVpButton && awardVpModal) {
    const closeAwardVpModal = () => awardVpModal.classList.add('hidden');
    awardVpButton.addEventListener('click', () => awardVpModal.classList.remove('hidden'));
    document.getElementById('cancelAwardVp').addEventListener('click', closeAwardVpModal);
    awardVpModal.addEventListener('click', event => {
        if (event.target === awardVpModal) closeAwardVpModal();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !awardVpModal.classList.contains('hidden')) closeAwardVpModal();
    });
    awardVpChoices.querySelectorAll('[data-award-vp]').forEach(button => {
        button.addEventListener('click', async () => {
            closeAwardVpModal();
            awardVpButton.disabled = true;
            try {
                const response = await fetch('/catan2/load_play_state');
                const result = await response.json();
                if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Could not load game state');
                const player = result.play_state[button.dataset.awardVp];
                if (!player) throw new Error('Player not found');
                player.victory_point = (Number(player.victory_point) || 0) + 1;
                const awardLog = Array.isArray(result.play_state.vpAwardLog) ? result.play_state.vpAwardLog : [];
                awardLog.push({
                    playerId: button.dataset.awardVp,
                    playerName: player.playerName
                });
                result.play_state.vpAwardLog = awardLog;
                const saveResponse = await fetch('/catan2/save_play_state', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(result.play_state)
                });
                const saved = await saveResponse.json();
                if (!saveResponse.ok || saved.status !== 'success') throw new Error(saved.message || 'Could not save victory point');
                await loadAllStatesFromBackend();
            } catch (error) {
                showMessage(`Could not award VP: ${error.message}`, 'error');
            } finally {
                awardVpButton.disabled = false;
            }
        });
    });
}

const awardMetropolisButton = document.getElementById('awardMetropolisButton');
if (awardMetropolisButton) {
    const trackModal = document.getElementById('metropolisTrackModal');
    const playerModal = document.getElementById('metropolisPlayerModal');
    const playerButtons = playerModal.querySelectorAll('[data-metropolis-player]');
    const canOwnMetropolis = (player, track) =>
        Number(player?.citiesAndKnights?.improvements?.[track]) >= 4;
    let selectedTrack = null;
    const closeMetropolisModals = () => {
        trackModal.classList.add('hidden');
        playerModal.classList.add('hidden');
        selectedTrack = null;
    };
    awardMetropolisButton.addEventListener('click', () => trackModal.classList.remove('hidden'));
    document.getElementById('cancelMetropolisPlayer').addEventListener('click', closeMetropolisModals);
    [trackModal, playerModal].forEach(modal => {
        modal.addEventListener('click', event => {
            if (event.target === modal) closeMetropolisModals();
        });
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeMetropolisModals();
    });
    trackModal.querySelectorAll('[data-metropolis-track]').forEach(button => {
        button.addEventListener('click', () => {
            selectedTrack = button.dataset.metropolisTrack;
            playerButtons.forEach(playerButton => {
                const player = allPlayersData[playerButton.dataset.metropolisPlayer];
                playerButton.disabled = !canOwnMetropolis(player, selectedTrack);
                playerButton.title = playerButton.disabled
                    ? `Requires ${button.textContent} progress level 4`
                    : '';
            });
            document.getElementById('metropolisPlayerTitle').textContent = `${button.textContent} Metropolis`;
            trackModal.classList.add('hidden');
            playerModal.classList.remove('hidden');
        });
    });
    playerButtons.forEach(button => {
        button.addEventListener('click', async () => {
            const track = selectedTrack;
            const playerId = button.dataset.metropolisPlayer;
            closeMetropolisModals();
            if (!track) return;
            awardMetropolisButton.disabled = true;
            try {
                const response = await fetch('/catan2/load_play_state');
                const result = await response.json();
                if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Could not load game state');
                const state = result.play_state;
                const player = state[playerId];
                if (!player) throw new Error('Player not found');
                if (!canOwnMetropolis(player, track)) {
                    throw new Error(`${player.playerName} needs ${track} progress level 4`);
                }
                const owners = state.metropolisOwners || {};
                const previousOwnerId = owners[track];
                if (previousOwnerId === playerId) return;
                owners[track] = playerId;
                state.metropolisOwners = owners;
                const log = Array.isArray(state.vpAwardLog) ? state.vpAwardLog : [];
                log.push({
                    type: 'metropolis',
                    track: track[0].toUpperCase() + track.slice(1),
                    playerName: player.playerName,
                    previousOwnerName: previousOwnerId ? state[previousOwnerId]?.playerName : null
                });
                state.vpAwardLog = log;
                const saveResponse = await fetch('/catan2/save_play_state', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(state)
                });
                const saved = await saveResponse.json();
                if (!saveResponse.ok || saved.status !== 'success') throw new Error(saved.message || 'Could not save metropolis');
                await loadAllStatesFromBackend();
            } catch (error) {
                showMessage(`Could not award metropolis: ${error.message}`, 'error');
            } finally {
                awardMetropolisButton.disabled = false;
            }
        });
    });
}
const awardTitleButton = document.getElementById('awardTitleButton');
if (awardTitleButton) {
    const playerModal = document.getElementById('titlePlayerModal');
    const closeTitleModal = () => {
        playerModal.classList.add('hidden');
    };
    awardTitleButton.addEventListener('click', () => playerModal.classList.remove('hidden'));
    document.getElementById('cancelTitlePlayer').addEventListener('click', closeTitleModal);
    playerModal.addEventListener('click', event => {
        if (event.target === playerModal) closeTitleModal();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeTitleModal();
    });
    playerModal.querySelectorAll('[data-title-player]').forEach(button => {
        button.addEventListener('click', async () => {
            const playerId = button.dataset.titlePlayer;
            closeTitleModal();
            awardTitleButton.disabled = true;
            try {
                const response = await fetch('/catan2/load_play_state');
                const result = await response.json();
                if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Could not load game state');
                const state = result.play_state;
                const player = state[playerId];
                if (!player) throw new Error('Player not found');
                const playerIds = ['player1', 'player2', 'player3', 'player4'];
                const previousOwnerId = playerIds.find(id => state[id]?.longestroad);
                if (previousOwnerId === playerId) return;
                playerIds.forEach(id => {
                    state[id].longestroad = id === playerId ? 1 : 0;
                    state[id].longestroadmanual = id === playerId ? 1 : 0;
                });
                const log = Array.isArray(state.vpAwardLog) ? state.vpAwardLog : [];
                log.push({
                    type: 'title',
                    title: 'Longest Road',
                    playerName: player.playerName,
                    previousOwnerName: previousOwnerId ? state[previousOwnerId].playerName : null
                });
                state.vpAwardLog = log;
                const saveResponse = await fetch('/catan2/save_play_state', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(state)
                });
                const saved = await saveResponse.json();
                if (!saveResponse.ok || saved.status !== 'success') throw new Error(saved.message || 'Could not save Longest Road');
                await loadAllStatesFromBackend();
            } catch (error) {
                showMessage(`Could not award Longest Road: ${error.message}`, 'error');
            } finally {
                awardTitleButton.disabled = false;
            }
        });
    });
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

socket.on('catan2_update', async () => {
    console.log('Received catan2_update from server. Reloading state...');
    // Reload all states from the backend and update the UI
    await loadAllStatesFromBackend();
    updatePlayerUI();

    
});

socket.on('catan2_score_update_broadcast', () => {
    renderGameScoreboard();
});

socket.on('catan2_activity_log_broadcast', data => {
    if (!isGamePage || !Array.isArray(data?.entries)) return;
    allPlayersData.activityLog = data.entries;
    renderActivityLog();
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
