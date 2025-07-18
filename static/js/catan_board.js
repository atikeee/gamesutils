        const canvas = document.getElementById('catanBoard');
        const ctx = canvas.getContext('2d');
        const messageBox = document.getElementById('messageBox');

        const isGamePage = window.location.pathname === '/catan_game';
        const isPlayerPage = window.location.pathname.startsWith('/catan_player/');

        const PLAYER_ID = isPlayerPage ? 'player' + window.PLAYER_ID : null;

        const HEX_SIZE = 80;
        const TILE_RADIUS = HEX_SIZE;
        const NUMBER_RADIUS = HEX_SIZE * 0.3;
        const ROAD_WIDTH = 12;
        const HOUSE_SIZE = 20;
        const CITY_SIZE = 30;
        const PORT_SIZE = HEX_SIZE * 0.3;

        const PLAYER_COLORS = {
            'player1': '#FF6347',
            'player2': '#4682B4',
            'player3': '#32CD32',
            'player4': '#FFD700'
        };

        const RESOURCE_COLORS = {
            'wood': '#3CB371',
            'brick': '#CD5C5C',
            'sheep': '#90EE90',
            'wheat': '#DAA520',
            'ore': '#708090',
            'desert': '#F4A460',
        };
        const NUMBER_COLOR = '#333';
        const ROBBER_COLOR = '#333';

        const resourceImagePaths = {
            'wood': 'https://placehold.co/200x200/3CB371/ffffff?text=Forest',
            'brick': 'https://placehold.co/200x200/CD5C5C/ffffff?text=Brickfield',
            'sheep': 'https://placehold.co/200x200/90EE90/000000?text=Sheep+Field',
            'wheat': 'https://placehold.co/200x200/DAA520/ffffff?text=Hay+Field',
            'ore': 'https://placehold.co/200x200/708090/ffffff?text=Rocky+Mountain',
            'desert': 'https://placehold.co/200x200/F4A460/ffffff?text=Desert'
        };
        const loadedResourceImages = {};

        let boardTiles = [];
        let PORT_DATA = [];
        let robberTile = null;

        let allPlayersData = {
            'player1': { roads: [], structures: [] },
            'player2': { roads: [], structures: [] },
            'player3': { roads: [], structures: [] },
            'player4': { roads: [], structures: [] }
        };

        let currentPlayerState = {
            playerName: `Player ${PLAYER_ID || 'Unknown'}`,
            roads: [],
            structures: [],
            hand: {},
            devCards: [],
            history: []
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
                loadBoardFromBackend();
                return;
            }

            for (const type in resourceImagePaths) {
                const img = new Image();
                img.src = resourceImagePaths[type];
                img.onload = () => {
                    loadedResourceImages[type] = img;
                    imagesToLoad--;
                    if (imagesToLoad === 0) {
                        loadBoardFromBackend();
                    }
                };
                img.onerror = () => {
                    console.error(`Failed to load image for ${type}: ${resourceImagePaths[type]}`);
                    loadedResourceImages[type] = null;
                    imagesToLoad--;
                    if (imagesToLoad === 0) {
                        loadBoardFromBackend();
                    }
                };
            }
        }

        function hexToPixel(q, r) {
            const x = HEX_SIZE * (3/2 * q);
            const y = HEX_SIZE * (Math.sqrt(3) * r + Math.sqrt(3)/2 * q);
            return { x: x + offsetX, y: y + offsetY };
        }

        function hexToRawPixel(q, r) {
            const x = HEX_SIZE * (3/2 * q);
            const y = HEX_SIZE * (Math.sqrt(3) * r + Math.sqrt(3)/2 * q);
            return { x: x, y: y };
        }

        function pixelToHex(px, py) {
            const x = px - offsetX;
            const y = py - offsetY;

            const q = (2/3 * x) / HEX_SIZE;
            const r = (-1/3 * x + Math.sqrt(3)/3 * y) / HEX_SIZE;

            let rx = Math.round(q);
            let ry = Math.round(r);
            let rz = Math.round(-q - r);

            const x_diff = Math.abs(rx - q);
            const y_diff = Math.abs(ry - r);
            const z_diff = Math.abs(rz - (-q - r));

            if (x_diff > y_diff && x_diff > z_diff) {
                rx = -ry - rz;
            } else if (y_diff > z_diff) {
                ry = -rx - rz;
            } else {
                rz = -rx - ry;
            }
            return { q: rx, r: ry };
        }

        function getHexVertices(centerX, centerY, size) {
            const vertices = [];
            for (let i = 0; i < 6; i++) {
                const angle_deg = 60 * i;
                const angle_rad = Math.PI / 180 * angle_deg;
                vertices.push({
                    x: centerX + size * Math.cos(angle_rad),
                    y: centerY + size * Math.sin(angle_rad)
                });
            }
            return vertices;
        }

        function drawHex(ctx, x, y, size, fillColor, image = null, strokeColor = '#333', lineWidth = 2) {
            ctx.beginPath();
            const vertices = getHexVertices(x, y, size);
            ctx.moveTo(vertices[0].x, vertices[0].y);
            for (let i = 1; i < 6; i++) {
                ctx.lineTo(vertices[i].x, vertices[i].y);
            }
            ctx.closePath();

            ctx.save();
            ctx.clip();

            if (image && image.complete && image.naturalWidth > 0) {
                const hexWidth = size * 2;
                const hexHeight = size * Math.sqrt(3);
                const scaleX = hexWidth / image.naturalWidth;
                const scaleY = hexHeight / image.naturalHeight;
                const scale = Math.max(scaleX, scaleY);

                const imgWidth = image.naturalWidth * scale;
                const imgHeight = image.naturalHeight * scale;

                ctx.drawImage(image, x - imgWidth / 2, y - imgHeight / 2, imgWidth, imgHeight);
            } else {
                ctx.fillStyle = fillColor;
                ctx.fill();
            }
            ctx.restore();

            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = lineWidth;
            ctx.stroke();
        }

        function drawNumber(ctx, x, y, number) {
            if (number === null) return;

            ctx.beginPath();
            ctx.arc(x, y, NUMBER_RADIUS, 0, Math.PI * 2);

            if (number === 6 || number === 8) {
                ctx.fillStyle = 'red';
                ctx.fill();
                ctx.strokeStyle = '#666';
                ctx.lineWidth = 1;
                ctx.stroke();
                ctx.fillStyle = 'white';
            } else {
                ctx.fillStyle = '#FFFAF0';
                ctx.fill();
                ctx.strokeStyle = '#666';
                ctx.lineWidth = 1;
                ctx.stroke();
                ctx.fillStyle = NUMBER_COLOR;
            }

            ctx.font = `bold ${NUMBER_RADIUS * 0.8}px Inter`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(number, x, y - NUMBER_RADIUS * 0.25);

            let numDots = 0;
            switch (number) {
                case 2: case 12: numDots = 1; break;
                case 3: case 11: numDots = 2; break;
                case 4: case 10: numDots = 3; break;
                case 5: case 9: numDots = 4; break;
                case 6: case 8: numDots = 5; break;
                default: numDots = 0;
            }

            const dotRadius = NUMBER_RADIUS * 0.08;
            const dotSpacing = NUMBER_RADIUS * 0.2;
            const startX = x - ((numDots - 1) * dotSpacing) / 2;
            const dotY = y + NUMBER_RADIUS * 0.35;

            ctx.fillStyle = (number === 6 || number === 8) ? 'white' : NUMBER_COLOR;
            for (let i = 0; i < numDots; i++) {
                ctx.beginPath();
                ctx.arc(startX + i * dotSpacing, dotY, dotRadius, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        function drawWoodPortIcon(ctx, x, y, iconSize) {
            ctx.fillStyle = '#8B4513';
            ctx.fillRect(x - iconSize * 0.2, y - iconSize * 0.2, iconSize * 0.4, iconSize * 0.4);
            ctx.strokeStyle = '#654321';
            ctx.lineWidth = 1;
            ctx.strokeRect(x - iconSize * 0.2, y - iconSize * 0.2, iconSize * 0.4, iconSize * 0.4);
        }

        function drawBrickPortIcon(ctx, x, y, iconSize) {
            ctx.fillStyle = '#B22222';
            const brickWidth = iconSize * 0.4;
            const brickHeight = iconSize * 0.15;
            ctx.fillRect(x - brickWidth / 2, y - brickHeight / 2, brickWidth, brickHeight);
            ctx.strokeStyle = '#8B0000';
            ctx.lineWidth = 1;
            ctx.strokeRect(x - brickWidth / 2, y - brickHeight / 2, brickWidth, brickHeight);
        }

        function drawSheepPortIcon(ctx, x, y, iconSize) {
            ctx.fillStyle = '#F0F8FF';
            ctx.strokeStyle = '#696969';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(x, y, iconSize * 0.3, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }

        function drawWheatPortIcon(ctx, x, y, iconSize) {
            ctx.fillStyle = '#FFD700';
            ctx.strokeStyle = '#B8860B';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(x, y - iconSize * 0.3);
            ctx.lineTo(x - iconSize * 0.1, y + iconSize * 0.1);
            ctx.lineTo(x + iconSize * 0.1, y + iconSize * 0.1);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        }

        function drawOrePortIcon(ctx, x, y, iconSize) {
            ctx.fillStyle = '#A9A9A9';
            ctx.strokeStyle = '#696969';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x, y, iconSize * 0.3, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }

        function drawCirclePort(ctx, x, y, type, ratio, backgroundImage = null) {
            ctx.save();
            ctx.translate(x, y);

            const circleRadius = PORT_SIZE;
            ctx.beginPath();
            ctx.arc(0, 0, circleRadius, 0, Math.PI * 2);

            if (backgroundImage && backgroundImage.complete && backgroundImage.naturalWidth > 0) {
                const imgScale = Math.max(circleRadius * 2 / backgroundImage.naturalWidth, circleRadius * 2 / backgroundImage.naturalHeight);
                const imgWidth = backgroundImage.naturalWidth * imgScale;
                const imgHeight = backgroundImage.naturalHeight * imgScale;
                ctx.clip();
                ctx.drawImage(backgroundImage, -imgWidth / 2, -imgHeight / 2, imgWidth, imgHeight);
            } else {
                ctx.fillStyle = '#D3D3D3';
                ctx.fill();
            }

            ctx.strokeStyle = '#666';
            ctx.lineWidth = 1;
            ctx.stroke();

            const iconSize = PORT_SIZE * 0.6;
            const iconYOffset = -circleRadius * 0.3;
            if (type !== 'any') {
                switch (type) {
                    case 'wood': drawWoodPortIcon(ctx, 0, iconYOffset, iconSize); break;
                    case 'brick': drawBrickPortIcon(ctx, 0, iconYOffset, iconSize); break;
                    case 'sheep': drawSheepPortIcon(ctx, 0, iconYOffset, iconSize); break;
                    case 'wheat': drawWheatPortIcon(ctx, 0, iconYOffset, iconSize); break;
                    case 'ore': drawOrePortIcon(ctx, 0, iconYOffset, iconSize); break;
                }
            } else {
                ctx.fillStyle = '#333';
                ctx.font = `bold ${iconSize * 0.7}px Inter`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('?', 0, iconYOffset);
            }

            ctx.fillStyle = '#333';
            ctx.font = `bold ${PORT_SIZE * 0.4}px Inter`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const ratioYOffset = circleRadius * 0.3;
            ctx.fillText(ratio, 0, ratioYOffset);

            ctx.restore();
        }

        function drawRoad(ctx, edge, color) {
            ctx.beginPath();
            const x1 = edge.x1 + offsetX;
            const y1 = edge.y1 + offsetY;
            const x2 = edge.x2 + offsetX;
            const y2 = edge.y2 + offsetY;
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.strokeStyle = color;
            ctx.lineWidth = ROAD_WIDTH;
            ctx.lineCap = 'butt';
            ctx.stroke();
        }

        function drawHouse(ctx, junction, color) {
            const x = junction.x + offsetX;
            const y = junction.y + offsetY;
            const size = HOUSE_SIZE;

            ctx.fillStyle = color;
            ctx.strokeStyle = '#333';
            ctx.lineWidth = 2;

            ctx.fillRect(x - size / 2, y - size / 2, size, size);
            ctx.strokeRect(x - size / 2, y - size / 2, size, size);

            ctx.beginPath();
            ctx.moveTo(x - size * 0.7, y - size / 2);
            ctx.lineTo(x + size * 0.7, y - size / 2);
            ctx.lineTo(x, y - size * 1.2);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = '#8B4513';
            ctx.fillRect(x - size * 0.15, y + size * 0.05, size * 0.3, size * 0.45);
            ctx.strokeRect(x - size * 0.15, y + size * 0.05, size * 0.3, size * 0.45);
        }

        function drawCity(ctx, junction, color) {
            const x = junction.x + offsetX;
            const y = junction.y + offsetY;
            const size = CITY_SIZE;

            ctx.fillStyle = color;
            ctx.strokeStyle = '#333';
            ctx.lineWidth = 2;

            ctx.fillRect(x - size / 2, y - size / 2, size, size);
            ctx.strokeRect(x - size / 2, y - size / 2, size, size);

            ctx.fillRect(x - size * 0.4, y - size * 1.1, size * 0.3, size * 0.6);
            ctx.strokeRect(x - size * 0.4, y - size * 1.1, size * 0.3, size * 0.6);

            ctx.fillRect(x + size * 0.1, y - size * 1.1, size * 0.3, size * 0.6);
            ctx.strokeRect(x + size * 0.1, y - size * 1.1, size * 0.3, size * 0.6);

            ctx.fillRect(x - size / 2, y - size / 2 - 5, size / 5, 5);
            ctx.fillRect(x - size / 10, y - size / 2 - 5, size / 5, 5);
            ctx.fillRect(x + size / 5, y - size / 2 - 5, size / 5, 5);
        }

        function drawRobber(ctx, tile) {
            const pixel = hexToPixel(tile.q, tile.r);
            const x = pixel.x;
            const y = pixel.y;
            const robberSize = HEX_SIZE * 0.3;

            ctx.fillStyle = ROBBER_COLOR;
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 2;

            ctx.beginPath();
            ctx.arc(x, y + robberSize * 0.4, robberSize * 0.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(x - robberSize * 0.3, y + robberSize * 0.4);
            ctx.lineTo(x - robberSize * 0.3, y - robberSize * 0.1);
            ctx.arc(x, y - robberSize * 0.1, robberSize * 0.3, Math.PI, 0, true);
            ctx.lineTo(x + robberSize * 0.3, y + robberSize * 0.4);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(x, y - robberSize * 0.4, robberSize * 0.25, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }

        function countTilesForJunction(junction) {
            let count = 0;
            boardTiles.forEach(tile => {
                const rawPixel = hexToRawPixel(tile.q, tile.r);
                const vertices = getHexVertices(rawPixel.x, rawPixel.y, TILE_RADIUS);
                if (vertices.some(v => Math.abs(v.x - junction.x) < 1 && Math.abs(v.y - junction.y) < 1)) {
                    count++;
                }
            });
            return count;
        }

        function drawBoard() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            boardTiles.forEach(tile => {
                const pixel = hexToPixel(tile.q, tile.r);
                const image = loadedResourceImages[tile.type];
                drawHex(ctx, pixel.x, pixel.y, TILE_RADIUS, RESOURCE_COLORS[tile.type], image);
                if (tile.number !== null) {
                    drawNumber(ctx, pixel.x, pixel.y, tile.number);
                }
            });

            for (const playerId in allPlayersData) {
                const playerData = allPlayersData[playerId];
                if (playerData) {
                    playerData.roads.forEach(road => {
                        drawRoad(ctx, road.edge, PLAYER_COLORS[road.owner]);
                    });
                    playerData.structures.forEach(structure => {
                        const ownerColor = PLAYER_COLORS[structure.owner];
                        if (structure.type === 'house') {
                            drawHouse(ctx, structure.junction, ownerColor);
                        } else if (structure.type === 'city') {
                            drawCity(ctx, structure.junction, ownerColor);
                        }
                    });
                }
            }

            if (robberTile) {
                drawRobber(ctx, robberTile);
            }

            if (allJunctions.length === 0 && boardTiles.length > 0) {
                allJunctions = getAllJunctions();
            }

            const perimeterJunctions = allJunctions.filter(junction => countTilesForJunction(junction) < 3);

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
                        const pixel = hexToPixel(selectedSwapItem1.tile.q, selectedSwapItem1.tile.r);
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
                        const pixel = hexToPixel(selectedSwapItem2.tile.q, selectedSwapItem2.tile.r);
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
                portData: JSON.parse(JSON.stringify(PORT_DATA)),
                robber: robberTile ? JSON.parse(JSON.stringify(robberTile)) : null,
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
                PORT_DATA.splice(0, PORT_DATA.length, ...JSON.parse(JSON.stringify(prevState.portData)));
                robberTile = prevState.robber ? JSON.parse(JSON.stringify(prevState.robber)) : null;

                selectedSwapItem1 = null;
                selectedSwapItem2 = null;

                showMessage('Last action undone.');
                drawBoard();
            } else {
                showMessage('No more actions to undo.', 'error');
            }
        }

        function savePlayerStateToHistory() {
            if (!isPlayerPage) return;

            currentPlayerState.history.push({
                roads: JSON.parse(JSON.stringify(allPlayersData[PLAYER_ID].roads)),
                structures: JSON.parse(JSON.stringify(allPlayersData[PLAYER_ID].structures)),
                robber: robberTile ? JSON.parse(JSON.stringify(robberTile)) : null
            });
        }

        function undoPlayerLastAction() {
            if (!isPlayerPage) return;

            if (currentPlayerState.history.length > 1) {
                currentPlayerState.history.pop();
                const prevState = currentPlayerState.history[currentPlayerState.history.length - 1];

                allPlayersData[PLAYER_ID].roads = JSON.parse(JSON.stringify(prevState.roads));
                allPlayersData[PLAYER_ID].structures = JSON.parse(JSON.stringify(prevState.structures));
                robberTile = prevState.robber ? JSON.parse(JSON.stringify(prevState.robber)) : null;

                currentPlayerState.roads = JSON.parse(JSON.stringify(allPlayersData[PLAYER_ID].roads));
                currentPlayerState.structures = JSON.parse(JSON.stringify(allPlayersData[PLAYER_ID].structures));

                showMessage('Your last action undone.');
                drawBoard();
                savePlayerStateToBackend();
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

        async function saveBoardToBackend() {
            if (isGamePage || isPlayerPage) return;

            try {
                const boardState = {
                    boardTiles: boardTiles.map(tile => ({
                        q: tile.q,
                        r: tile.r,
                        type: tile.type,
                        number: tile.number
                    })),
                    portData: PORT_DATA,
                    robberTile: robberTile ? { q: robberTile.q, r: robberTile.r } : null
                };
                const response = await fetch('/save_board', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(boardState),
                });
                const result = await response.json();
                if (result.status === 'success') {
                    showMessage(result.message);
                } else {
                    showMessage('Error saving board state: ' + result.message, 'error');
                }
            } catch (e) {
                showMessage('Network error saving board state: ' + e.message, 'error');
                console.error('Error saving board state to backend:', e);
            }
        }

        async function loadBoardFromBackend() {
            try {
                const response = await fetch('/load_board');
                const result = await response.json();
                if (result.status === 'success' && result.board_state) {
                    boardTiles = result.board_state.boardTiles;
                    PORT_DATA = result.board_state.portData;
                    robberTile = result.board_state.robberTile;
                    if (!isGamePage && !isPlayerPage) {
                        saveBuilderState();
                    }
                    showMessage('Board state loaded successfully!');
                } else {
                    showMessage((result.message || "No saved board state found.") + ' Displaying default board.', 'info');
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

                    PORT_DATA = [
                        null, null, null, null, null, null, null, null,
                        ['wood', '2:1'], ['brick', '2:1'], ['sheep', '2:1'],
                        null, null,
                        ['any', '3:1'],
                        null, null,
                        ['wheat', '2:1'],
                        null, null,
                        ['any', '3:1'],
                        null, null,
                        ['ore', '2:1'],
                        null,
                        ['any', '3:1'],
                        null, null,
                        ['any', '3:1'],
                        null, null
                    ];
                    robberTile = boardTiles.find(tile => tile.type === 'desert');
                    if (!isGamePage && !isPlayerPage) {
                        saveBuilderState();
                    }
                }
                allJunctions = getAllJunctions();
                allEdges = getAllEdges();
                resizeCanvas();
            } catch (e) {
                showMessage('Network error loading board state: ' + e.message + '. Displaying default board.', 'error');
                console.error('Error loading board state from backend:', e);
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

                PORT_DATA = [
                    null, null, null, null, null, null, null, null,
                    ['wood', '2:1'], ['brick', '2:1'], ['sheep', '2:1'],
                    null, null,
                    ['any', '3:1'],
                    null, null,
                    ['wheat', '2:1'],
                    null, null,
                    ['any', '3:1'],
                    null, null,
                    ['ore', '2:1'],
                    null,
                    ['any', '3:1'],
                    null, null,
                    ['any', '3:1'],
                    null, null
                ];
                robberTile = boardTiles.find(tile => tile.type === 'desert');
                allJunctions = getAllJunctions();
                allEdges = getAllEdges();
                resizeCanvas();
            }
        }

        async function savePlayerStateToBackend() {
            if (!PLAYER_ID) return;

            try {
                const playerStateToSave = {
                    playerName: currentPlayerState.playerName,
                    roads: allPlayersData[PLAYER_ID].roads.map(road => ({ edge: road.edge.id, owner: road.owner })),
                    structures: allPlayersData[PLAYER_ID].structures.map(s => ({ type: s.type, junction: s.junction.id, owner: s.owner })),
                    hand: currentPlayerState.hand,
                    devCards: currentPlayerState.devCards,
                    robberTile: robberTile ? { q: robberTile.q, r: robberTile.r } : null
                };

                const response = await fetch(`/save_player_state/${PLAYER_ID}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(playerStateToSave),
                });
                const result = await response.json();
                if (result.status === 'success') {
                } else {
                    console.error('Error saving player state:', result.message);
                    showMessage('Error saving player state: ' + result.message, 'error');
                }
            } catch (e) {
                console.error('Network error saving player state:', e);
                showMessage('Network error saving player state: ' + e.message, 'error');
            }
        }

        async function loadPlayerStateFromBackend() {
            if (!PLAYER_ID) return;

            try {
                const response = await fetch(`/load_player_state/${PLAYER_ID}`);
                const result = await response.json();
                if (result.status === 'success' && result.player_state) {
                    const loadedState = result.player_state;
                    currentPlayerState.playerName = loadedState.playerName || `Player ${PLAYER_ID}`;
                    currentPlayerState.hand = loadedState.hand || {};
                    currentPlayerState.devCards = loadedState.devCards || [];

                    allPlayersData[PLAYER_ID].roads = (loadedState.roads || []).map(r => ({
                        edge: allEdges.find(edge => edge.id === r.edge),
                        owner: r.owner
                    })).filter(r => r.edge);
                    allPlayersData[PLAYER_ID].structures = (loadedState.structures || []).map(s => ({
                        type: s.type,
                        junction: allJunctions.find(j => j.id === s.junction),
                        owner: s.owner
                    })).filter(s => s.junction);

                    currentPlayerState.roads = JSON.parse(JSON.stringify(allPlayersData[PLAYER_ID].roads));
                    currentPlayerState.structures = JSON.parse(JSON.stringify(allPlayersData[PLAYER_ID].structures));

                    if (loadedState.robberTile) {
                        robberTile = boardTiles.find(t => t.q === loadedState.robberTile.q && t.r === loadedState.robberTile.r);
                    } else {
                        robberTile = boardTiles.find(tile => tile.type === 'desert');
                    }

                    currentPlayerState.history = [];
                    savePlayerStateToHistory();

                    updatePlayerUI();
                    showMessage(`Player ${PLAYER_ID} state loaded successfully!`);
                } else {
                    showMessage(`No saved state found for Player ${PLAYER_ID}. Initializing new player state.`, 'info');
                    currentPlayerState = {
                        playerName: `Player ${PLAYER_ID}`,
                        roads: [],
                        structures: [],
                        hand: { 'wood': 0, 'brick': 0, 'sheep': 0, 'wheat': 0, 'ore': 0 },
                        devCards: [],
                        history: []
                    };
                    allPlayersData[PLAYER_ID] = {
                        roads: [],
                        structures: []
                    };
                    savePlayerStateToHistory();
                    savePlayerStateToBackend();
                }
                drawBoard();
            } catch (e) {
                showMessage('Network error loading player state: ' + e.message, 'error');
                console.error('Error loading player state from backend:', e);
                currentPlayerState = {
                    playerName: `Player ${PLAYER_ID}`,
                    roads: [],
                    structures: [],
                    hand: { 'wood': 0, 'brick': 0, 'sheep': 0, 'wheat': 0, 'ore': 0 },
                    devCards: [],
                    history: []
                };
                allPlayersData[PLAYER_ID] = {
                    roads: [],
                    structures: []
                };
                savePlayerStateToHistory();
                drawBoard();
                updatePlayerUI();
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

        function isPointInNumberCircle(px, py, tile) {
            if (tile.number === null) return false;

            const pixel = hexToPixel(tile.q, tile.r);
            const dist = Math.sqrt(Math.pow(px - pixel.x, 2) + Math.pow(py - pixel.y, 2));
            return dist < NUMBER_RADIUS;
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
                    const clickedHex = pixelToHex(mouseX, mouseY);
                    const clickedTile = boardTiles.find(t => t.q === clickedHex.q && t.r === clickedHex.r);

                    if (clickedTile) {
                        const isNumberClick = isPointInNumberCircle(mouseX, mouseY, clickedTile);
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
                            if (allPlayersData[pId].structures.some(s => s.junction.id === clickedJunction.id)) {
                                existingStructure = true;
                                break;
                            }
                        }

                        if (existingStructure) {
                            showMessage('A structure already exists here.', 'error');
                        } else {
                            savePlayerStateToHistory();
                            allPlayersData[PLAYER_ID].structures.push({ type: 'house', junction: clickedJunction, owner: PLAYER_ID });
                            currentPlayerState.structures = JSON.parse(JSON.stringify(allPlayersData[PLAYER_ID].structures));
                            showMessage('House placed!');
                            actionSuccessful = true;
                        }
                    } else {
                        showMessage('Click near a junction to place a house.', 'error');
                    }
                } else if (selectedPlayerTool === 'city') {
                    const clickedJunction = getClosestJunction(mouseX, mouseY);
                    if (clickedJunction) {
                        const existingHouse = allPlayersData[PLAYER_ID].structures.find(s => s.junction.id === clickedJunction.id && s.type === 'house' && s.owner === PLAYER_ID);
                        if (existingHouse) {
                            savePlayerStateToHistory();
                            existingHouse.type = 'city';
                            currentPlayerState.structures = JSON.parse(JSON.stringify(allPlayersData[PLAYER_ID].structures));
                            showMessage('City placed!');
                            actionSuccessful = true;
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
                            if (allPlayersData[pId].roads.some(r => r.edge.id === clickedEdge.id)) {
                                existingRoad = true;
                                break;
                            }
                        }

                        if (existingRoad) {
                            showMessage('A road already exists here.', 'error');
                        } else {
                            savePlayerStateToHistory();
                            allPlayersData[PLAYER_ID].roads.push({ edge: clickedEdge, owner: PLAYER_ID });
                            currentPlayerState.roads = JSON.parse(JSON.stringify(allPlayersData[PLAYER_ID].roads));
                            showMessage('Road placed!');
                            actionSuccessful = true;
                        }
                    } else {
                        showMessage('Click near an edge to place a road.', 'error');
                    }
                } else if (selectedPlayerTool === 'robber') {
                    const clickedHex = pixelToHex(mouseX, mouseY);
                    const clickedTile = boardTiles.find(t => t.q === clickedHex.q && t.r === clickedHex.r);
                    if (clickedTile) {
                        if (robberTile && robberTile.q === clickedTile.q && robberTile.r === clickedTile.r) {
                            showMessage('Robber is already on this tile.', 'info');
                        } else {
                            savePlayerStateToHistory();
                            robberTile = clickedTile;
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
                    savePlayerStateToBackend();
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
                        saveBoardToBackend();
                    } else if (selectedTool === 'load-board') {
                        loadBoardFromBackend();
                    }
                    showMessage(`Selected tool: ${selectedTool}`);
                    drawBoard();
                }
            });
        }

        if (isPlayerPage) {
            document.getElementById('savePlayerNameBtn').addEventListener('click', () => {
                const newName = document.getElementById('playerNameInput').value.trim();
                if (newName) {
                    currentPlayerState.playerName = newName;
                    updatePlayerUI();
                    savePlayerStateToBackend();
                    showMessage('Player name saved!');
                } else {
                    showMessage('Player name cannot be empty.', 'error');
                }
            });

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

            document.querySelector('.card-buttons').addEventListener('click', (event) => {
                const target = event.target;
                if (target.classList.contains('btn-tool')) {
                    const action = target.dataset.tool;
                    showMessage(`Action: ${action} (To be implemented)`);
                }
            });

            const resourceCardButtons = document.querySelectorAll('.resource-card-btn');
            resourceCardButtons.forEach(button => {
                button.addEventListener('click', async (event) => {
                    const resourceType = event.target.dataset.resourceType;
                    const confirmed = await showConfirmation(`Do you want to take 1 ${resourceType.charAt(0).toUpperCase() + resourceType.slice(1)} card?`);
                    if (confirmed) {
                        savePlayerStateToHistory();
                        currentPlayerState.hand[resourceType] = (currentPlayerState.hand[resourceType] || 0) + 1;
                        updatePlayerUI();
                        savePlayerStateToBackend();
                        showMessage(`You took 1 ${resourceType} card!`);
                    } else {
                        showMessage(`Cancelled taking ${resourceType} card.`);
                    }
                });
            });

            const devCardButton = document.querySelector('.dev-card-btn');
            devCardButton.addEventListener('click', async () => {
                const confirmed = await showConfirmation('Do you want to take 1 Development card?');
                if (confirmed) {
                    if (globalDevCardDeck.length === 0) {
                        initializeDevCardDeck();
                        showMessage('Development card deck was empty, re-initialized and shuffled.');
                    }
                    if (globalDevCardDeck.length > 0) {
                        savePlayerStateToHistory();
                        const drawnCard = globalDevCardDeck.pop();
                        currentPlayerState.devCards.push(drawnCard);
                        updatePlayerUI();
                        savePlayerStateToBackend();
                        showMessage(`You drew a ${drawnCard} Development Card!`);
                    } else {
                        showMessage('No Development cards left in the deck.', 'error');
                    }
                } else {
                    showMessage('Cancelled taking Development card.');
                }
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

            const aspectRatio = 1.2 / 1;
            let newWidth = containerWidth;
            let newHeight = newWidth / aspectRatio;

            if (newHeight > containerHeight) {
                newHeight = containerHeight;
                newWidth = newHeight * aspectRatio;
            }

            canvas.width = newWidth;
            canvas.height = newHeight;

            canvas.style.width = `${newWidth}px`;
            canvas.style.height = `${newHeight}px`;

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
            if (!isPlayerPage) return;

            const playerNameInput = document.getElementById('playerNameInput');
            const playerNameDisplay = document.getElementById('playerNameDisplay');
            if (playerNameInput) playerNameInput.value = currentPlayerState.playerName;
            if (playerNameDisplay) playerNameDisplay.textContent = currentPlayerState.playerName;

            const handCardsDiv = document.getElementById('handCards');
            if (handCardsDiv) {
                handCardsDiv.innerHTML = '';
                let handCount = 0;
                for (const resourceType in currentPlayerState.hand) {
                    const count = currentPlayerState.hand[resourceType];
                    if (count > 0) {
                        const cardItem = document.createElement('div');
                        cardItem.classList.add('card-item');
                        cardItem.textContent = `${resourceType.charAt(0).toUpperCase() + resourceType.slice(1)}: ${count}`;
                        handCardsDiv.appendChild(cardItem);
                        handCount += count;
                    }
                }
                document.getElementById('handCardCount').textContent = handCount;
            }

            const devCardsDiv = document.getElementById('devCards');
            if (devCardsDiv) {
                devCardsDiv.innerHTML = '';
                currentPlayerState.devCards.forEach(card => {
                    const cardItem = document.createElement('div');
                    cardItem.classList.add('card-item');
                    cardItem.textContent = card.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
                    devCardsDiv.appendChild(cardItem);
                });
                document.getElementById('devCardCount').textContent = currentPlayerState.devCards.length;
            }
        }

        async function onCatanPlayerPageLoad() {
            await loadPlayerStateFromBackend();
            updatePlayerUI();
            savePlayerStateToHistory();
        }

        window.addEventListener('load', async () => {
            await preloadImages();

            if (!isGamePage && !isPlayerPage) {
            } else if (isPlayerPage) {
                onCatanPlayerPageLoad();
            }
        });
        window.addEventListener('resize', resizeCanvas);
