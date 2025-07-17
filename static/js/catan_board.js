        const canvas = document.getElementById('catanBoard');
        const ctx = canvas.getContext('2d');
        const messageBox = document.getElementById('messageBox');

        // Determine if this is the game page or the board builder page
        const isGamePage = window.location.pathname === '/catan_game';
        // Determine if this is a player page
        const isPlayerPage = window.location.pathname.startsWith('/catan_player/');

        // Get PLAYER_ID if on a player page
        const PLAYER_ID = isPlayerPage ? window.PLAYER_ID : null;

        // Constants for board drawing (same for all pages)
        const HEX_SIZE = 80;
        const TILE_RADIUS = HEX_SIZE;
        const NUMBER_RADIUS = HEX_SIZE * 0.3;
        const ROAD_WIDTH = 12;
        const HOUSE_SIZE = 20;
        const CITY_SIZE = 30;
        const PORT_SIZE = HEX_SIZE * 0.3;

        // Player Colors (used for drawing player-owned elements)
        const PLAYER_COLORS = {
            'player1': '#FF6347', // Tomato
            'player2': '#4682B4', // SteelBlue
            'player3': '#32CD32', // LimeGreen
            'player4': '#FFD700'  // Gold
        };

        // Colors (fallback if images don't load)
        const RESOURCE_COLORS = {
            'wood': '#3CB371', // MediumSeaGreen
            'brick': '#CD5C5C', // IndianRed
            'sheep': '#90EE90', // LightGreen
            'wheat': '#DAA520', // Goldenrod
            'ore': '#708090', // SlateGray
            'desert': '#F4A460', // SandyBrown
        };
        const NUMBER_COLOR = '#333';
        const ROBBER_COLOR = '#333';

        // Image paths for resources (using placehold.co for placeholders)
        const resourceImagePaths = {
            'wood': 'https://placehold.co/200x200/3CB371/ffffff?text=Forest',
            'brick': 'https://placehold.co/200x200/CD5C5C/ffffff?text=Brickfield',
            'sheep': 'https://placehold.co/200x200/90EE90/000000?text=Sheep+Field',
            'wheat': 'https://placehold.co/200x200/DAA520/ffffff?text=Hay+Field',
            'ore': 'https://placehold.co/200x200/708090/ffffff?text=Rocky+Mountain',
            'desert': 'https://placehold.co/200x200/F4A460/ffffff?text=Desert'
        };
        const loadedResourceImages = {};

        // Board state (common to all pages, loaded from backend or default)
        let boardTiles = [];
        let PORT_DATA = [];
        let robberTile = null; // Robber position is global to the board

        // Player-specific state (loaded from backend)
        let currentPlayerState = {
            playerName: `Player ${PLAYER_ID || 'Unknown'}`,
            roads: [],
            structures: [], // {type: 'house'|'city', junction: {x,y,id}, owner: 'playerX'}
            hand: {}, // {resourceType: count}
            devCards: [], // ['knight', 'monopoly', ...]
            history: [] // Player-specific undo history
        };

        // Global offset to center the board
        let offsetX = 0;
        let offsetY = 0;

        // Global board center (raw pixel coordinates) for calculating outward vectors for ports
        let boardCenterRawX = 0;
        let boardCenterRawY = 0;

        // Builder-specific state
        let selectedTool = 'swap'; // Default tool for builder page
        let selectedSwapItem1 = null;
        let selectedSwapItem2 = null;
        let builderHistoryStack = []; // History for undo on builder page

        // Player-specific tool selection
        let selectedPlayerTool = null; // 'house', 'city', 'road', 'robber'
        let selectedRoadStartJunction = null; // For placing roads (not fully implemented in this version)


        // Initialize allJunctions and allEdges as 'let' so they can be reassigned
        // They will be populated after boardTiles is loaded/initialized.
        let allJunctions = [];
        let allEdges = [];


        /**
         * Utility function to show messages to the user.
         * @param {string} message - The message to display.
         * @param {string} type - Type of message (e.g., 'info', 'error').
         */
        function showMessage(message, type = 'info') {
            messageBox.textContent = message;
            messageBox.className = `message-box ${type === 'error' ? 'bg-red-100 text-red-800 border-red-300' : 'bg-yellow-100 text-yellow-800 border-yellow-300'}`;
            messageBox.classList.remove('hidden');
            setTimeout(() => {
                messageBox.classList.add('hidden');
            }, 3000);
        }

        /**
         * Preloads all resource images.
         * Calls loadBoardFromBackend once all images are loaded.
         */
        function preloadImages() {
            let imagesToLoad = Object.keys(resourceImagePaths).length;
            if (imagesToLoad === 0) {
                // If no images to load, directly load board data
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
                        loadBoardFromBackend(); // All images loaded, now load board data
                    }
                };
                img.onerror = () => {
                    console.error(`Failed to load image for ${type}: ${resourceImagePaths[type]}`);
                    loadedResourceImages[type] = null; // Fallback to solid color if image fails
                    imagesToLoad--;
                    if (imagesToLoad === 0) {
                        loadBoardFromBackend();
                    }
                };
            }
        }

        /**
         * Converts axial coordinates (q, r) to pixel coordinates (x, y).
         * This function now applies the global offsetX and offsetY.
         * @param {number} q - Axial q coordinate.
         * @param {number} r - Axial r coordinate.
         * @returns {{x: number, y: number}} Pixel coordinates.
         */
        function hexToPixel(q, r) {
            const x = HEX_SIZE * (3/2 * q);
            const y = HEX_SIZE * (Math.sqrt(3) * r + Math.sqrt(3)/2 * q);
            return { x: x + offsetX, y: y + offsetY };
        }

        /**
         * Converts axial coordinates (q, r) to pixel coordinates (x, y) WITHOUT applying global offsets.
         * Used for calculating raw board dimensions.
         * @param {number} q - Axial q coordinate.
         * @param {number} r - Axial r coordinate.
         * @returns {{x: number, y: number}} Raw pixel coordinates.
         */
        function hexToRawPixel(q, r) {
            const x = HEX_SIZE * (3/2 * q);
            const y = HEX_SIZE * (Math.sqrt(3) * r + Math.sqrt(3)/2 * q);
            return { x: x, y: y };
        }

        /**
         * Converts pixel coordinates (x, y) to axial (q, r) hex coordinates.
         * @param {number} px - Pixel x coordinate.
         * @param {number} py - Pixel y coordinate.
         * @returns {{q: number, r: number}} Axial coordinates.
         */
        function pixelToHex(px, py) {
            const x = px - offsetX;
            const y = py - offsetY;

            const q = (2/3 * x) / HEX_SIZE;
            const r = (-1/3 * x + Math.sqrt(3)/3 * y) / HEX_SIZE;

            // Round to nearest hex
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

        /**
         * Gets the vertices of a hexagon in pixel coordinates.
         * @param {number} centerX - X coordinate of the hexagon center.
         * @param {number} centerY - Y coordinate of the hexagon center.
         * @param {number} size - Size of the hexagon.
         * @returns {Array<{x: number, y: number}>} Array of vertex coordinates.
         */
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

        /**
         * Draws a hexagon on the canvas, optionally filling with an image.
         * @param {CanvasRenderingContext2D} ctx - The canvas rendering context.
         * @param {number} x - Center X coordinate.
         * @param {number} y - Center Y coordinate.
         * @param {number} size - Hexagon size.
         * @param {string} fillColor - Fallback fill color.
         * @param {HTMLImageElement} [image=null] - Image to draw.
         * @param {string} [strokeColor='#333'] - Stroke color.
         * @param {number} [lineWidth=2] - Line width.
         */
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

        /**
         * Draws the number token on a tile.
         * @param {CanvasRenderingContext2D} ctx - The canvas rendering context.
         * @param {number} x - Center X coordinate of the tile.
         * @param {number} y - Center Y coordinate of the tile.
         * @param {number} number - The number to draw.
         */
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

        /**
         * Draws a stylized wood icon for ports.
         */
        function drawWoodPortIcon(ctx, x, y, iconSize) {
            ctx.fillStyle = '#8B4513';
            ctx.fillRect(x - iconSize * 0.2, y - iconSize * 0.2, iconSize * 0.4, iconSize * 0.4);
            ctx.strokeStyle = '#654321';
            ctx.lineWidth = 1;
            ctx.strokeRect(x - iconSize * 0.2, y - iconSize * 0.2, iconSize * 0.4, iconSize * 0.4);
        }

        /**
         * Draws a stylized brick icon for ports.
         */
        function drawBrickPortIcon(ctx, x, y, iconSize) {
            ctx.fillStyle = '#B22222';
            const brickWidth = iconSize * 0.4;
            const brickHeight = iconSize * 0.15;
            ctx.fillRect(x - brickWidth / 2, y - brickHeight / 2, brickWidth, brickHeight);
            ctx.strokeStyle = '#8B0000';
            ctx.lineWidth = 1;
            ctx.strokeRect(x - brickWidth / 2, y - brickHeight / 2, brickWidth, brickHeight);
        }

        /**
         * Draws a stylized sheep icon for ports.
         */
        function drawSheepPortIcon(ctx, x, y, iconSize) {
            ctx.fillStyle = '#F0F8FF';
            ctx.strokeStyle = '#696969';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(x, y, iconSize * 0.3, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }

        /**
         * Draws a stylized wheat icon for ports.
         */
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

        /**
         * Draws a stylized ore icon for ports.
         */
        function drawOrePortIcon(ctx, x, y, iconSize) {
            ctx.fillStyle = '#A9A9A9';
            ctx.strokeStyle = '#696969';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x, y, iconSize * 0.3, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }

        /**
         * Draws a circular port sign.
         * @param {CanvasRenderingContext2D} ctx - The canvas rendering context.
         * @param {number} x - Center X coordinate for the circle.
         * @param {number} y - Center Y coordinate for the circle.
         * @param {string} type - Type of resource for the port ('wood', 'brick', 'any').
         * @param {string} ratio - The ratio (e.g., '2:1', '3:1').
         * @param {HTMLImageElement} [backgroundImage=null] - Optional image to draw as background.
         */
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

        /**
         * Draws a road on the canvas as a thick line along the hex edge.
         * @param {CanvasRenderingContext2D} ctx - The canvas rendering context.
         * @param {object} edge - The edge object with raw pixel coordinates.
         * @param {string} color - Color of the road.
         */
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

        /**
         * Draws a house on the canvas with more detail.
         * @param {CanvasRenderingContext2D} ctx - The canvas rendering context.
         * @param {object} junction - The junction object with raw pixel coordinates.
         * @param {string} color - Color of the house.
         */
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

        /**
         * Draws a city on the canvas with more detail.
         * @param {CanvasRenderingContext2D} ctx - The canvas rendering context.
         * @param {object} junction - The junction object with raw pixel coordinates.
         * @param {string} color - Color of the city.
         */
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

        /**
         * Draws the robber on a specified tile as a simple pawn-like shape.
         * @param {CanvasRenderingContext2D} ctx - The canvas rendering context.
         * @param {object} tile - The tile object where the robber is.
         */
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

        /**
         * Counts how many tiles a given junction belongs to.
         * @param {object} junction - The junction object {x, y, id} (raw coordinates).
         * @returns {number} The number of tiles this junction is a vertex of.
         */
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

        /**
         * Redraws the entire Catan board and all placed elements.
         */
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

            // Draw roads from all players (currently only current player's roads are in state)
            // In a full multi-player setup, you'd fetch and iterate through all players' road arrays
            currentPlayerState.roads.forEach(road => {
                drawRoad(ctx, road.edge, PLAYER_COLORS[road.owner]); // Use road's owner color
            });

            // Draw structures from all players (currently only current player's structures are in state)
            // Similarly, in a full multi-player setup, iterate through all players' structure arrays
            currentPlayerState.structures.forEach(structure => {
                const ownerColor = PLAYER_COLORS[structure.owner];
                if (structure.type === 'house') {
                    drawHouse(ctx, structure.junction, ownerColor);
                } else if (structure.type === 'city') {
                    drawCity(ctx, structure.junction, ownerColor);
                }
            });

            if (robberTile) {
                drawRobber(ctx, robberTile);
            }

            // Ensure allJunctions is populated before filtering
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

            // Draw highlights for selected tiles/numbers during swap (builder page only)
            if (!isGamePage && !isPlayerPage) { // Only on builder page
                if (selectedTool === 'swap') {
                    if (selectedSwapItem1) {
                        const pixel = hexToPixel(selectedSwapItem1.tile.q, selectedSwapItem1.tile.r);
                        ctx.strokeStyle = 'cyan'; // Highlight color for first selection
                        ctx.lineWidth = 4;

                        if (selectedSwapItem1.type === 'tile') {
                            // Highlight the entire tile
                            ctx.beginPath();
                            const vertices = getHexVertices(pixel.x, pixel.y, TILE_RADIUS);
                            ctx.moveTo(vertices[0].x, vertices[0].y);
                            for (let i = 1; i < 6; i++) {
                                ctx.lineTo(vertices[i].x, vertices[i].y);
                            }
                            ctx.closePath();
                            ctx.stroke();
                        } else if (selectedSwapItem1.type === 'number') {
                            // Highlight the number circle
                            ctx.beginPath();
                            ctx.arc(pixel.x, pixel.y, NUMBER_RADIUS + 2, 0, Math.PI * 2); // Slightly larger circle
                            ctx.stroke();
                        }
                    }
                    if (selectedSwapItem2) {
                        const pixel = hexToPixel(selectedSwapItem2.tile.q, selectedSwapItem2.tile.r);
                        ctx.strokeStyle = 'magenta'; // Different highlight color for second selection
                        ctx.lineWidth = 4;

                        if (selectedSwapItem2.type === 'tile') {
                            // Highlight the entire tile
                            ctx.beginPath();
                            const vertices = getHexVertices(pixel.x, pixel.y, TILE_RADIUS);
                            ctx.moveTo(vertices[0].x, vertices[0].y);
                            for (let i = 1; i < 6; i++) {
                                ctx.lineTo(vertices[i].x, vertices[i].y);
                            }
                            ctx.closePath();
                            ctx.stroke();
                        } else if (selectedSwapItem2.type === 'number') {
                            // Highlight the number circle
                            ctx.beginPath();
                            ctx.arc(pixel.x, pixel.y, NUMBER_RADIUS + 2, 0, Math.PI * 2); // Slightly larger circle
                            ctx.stroke();
                        }
                    }
                }
            }
        }

        /**
         * Saves the current state of the board to the history stack (builder page only).
         */
        function saveBuilderState() {
            if (isGamePage || isPlayerPage) return; // Only save state on the builder page

            builderHistoryStack.push({
                // Deep copy the arrays and objects to prevent direct reference issues
                tileStates: boardTiles.map(tile => ({ q: tile.q, r: tile.r, type: tile.type, number: tile.number })),
                portData: JSON.parse(JSON.stringify(PORT_DATA)),
                robber: robberTile ? JSON.parse(JSON.stringify(robberTile)) : null,
            });
            // Optional: Limit history stack size if it grows too large
            // if (builderHistoryStack.length > 50) {
            //     builderHistoryStack.shift(); // Remove the oldest state
            // }
        }

        /**
         * Undoes the last action by restoring the previous state from the history stack (builder page only).
         */
        function undoBuilderLastAction() {
            if (isGamePage || isPlayerPage) return; // Only undo on the builder page

            if (builderHistoryStack.length > 1) { // Keep at least one state (the initial board)
                builderHistoryStack.pop(); // Remove the current state
                const prevState = builderHistoryStack[builderHistoryStack.length - 1]; // Get the previous state

                // Restore board tiles
                prevState.tileStates.forEach(prevTile => {
                    const currentTile = boardTiles.find(t => t.q === prevTile.q && t.r === prevTile.r);
                    if (currentTile) {
                        currentTile.type = prevTile.type;
                        currentTile.number = prevTile.number;
                    }
                });
                PORT_DATA.splice(0, PORT_DATA.length, ...JSON.parse(JSON.stringify(prevState.portData)));
                robberTile = prevState.robber ? JSON.parse(JSON.stringify(prevState.robber)) : null;

                // Clear any active swap selections
                selectedSwapItem1 = null;
                selectedSwapItem2 = null;

                showMessage('Last action undone.');
                drawBoard();
            } else {
                showMessage('No more actions to undo.', 'error');
            }
        }

        /**
         * Saves the current player's state to their history stack (player page only).
         */
        function savePlayerStateToHistory() {
            if (!isPlayerPage) return; // Only save player state on player page

            currentPlayerState.history.push({
                roads: JSON.parse(JSON.stringify(currentPlayerState.roads)),
                structures: JSON.parse(JSON.stringify(currentPlayerState.structures)),
                // Robber position is global, but saving it with player history for undo consistency
                robber: robberTile ? JSON.parse(JSON.stringify(robberTile)) : null
            });
            // Optional: Limit history stack size
            // if (currentPlayerState.history.length > 20) {
            //     currentPlayerState.history.shift();
            // }
        }

        /**
         * Undoes the last action for the current player (player page only).
         */
        function undoPlayerLastAction() {
            if (!isPlayerPage) return; // Only undo on player page

            if (currentPlayerState.history.length > 1) {
                currentPlayerState.history.pop();
                const prevState = currentPlayerState.history[currentPlayerState.history.length - 1];
                currentPlayerState.roads = JSON.parse(JSON.stringify(prevState.roads));
                currentPlayerState.structures = JSON.parse(JSON.stringify(prevState.structures));
                robberTile = prevState.robber ? JSON.parse(JSON.stringify(prevState.robber)) : null;

                showMessage('Your last action undone.');
                drawBoard();
                savePlayerStateToBackend(); // Save updated player state to backend
            } else {
                showMessage('No more actions to undo for this player.', 'error');
            }
        }


        /**
         * Shuffles an array in place (Fisher-Yates algorithm).
         * @param {Array} array - The array to shuffle.
         */
        function shuffleArray(array) {
            for (let i = array.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [array[i], array[j]] = [array[j], array[i]];
            }
        }

        /**
         * Shuffles the resource types (cells) on the board, keeping the desert tile fixed (builder page only).
         */
        function shuffleCells() {
            if (isGamePage || isPlayerPage) return; // Only on builder page

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

        /**
         * Shuffles the numbers on the board, keeping the desert tile's number null (builder page only).
         */
        function shuffleNumbers() {
            if (isGamePage || isPlayerPage) return; // Only on builder page

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

        /**
         * Saves the current board state to the Flask backend (builder page only).
         */
        async function saveBoardToBackend() {
            if (isGamePage || isPlayerPage) return; // Only on builder page

            try {
                const boardState = {
                    boardTiles: boardTiles.map(tile => ({
                        q: tile.q,
                        r: tile.r,
                        type: tile.type,
                        number: tile.number
                    })),
                    portData: PORT_DATA,
                    robberTile: robberTile ? { q: robberTile.q, r: robberTile.r } : null // Save robber position with the board
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

        /**
         * Loads the board state from the Flask backend (common to all pages).
         */
        async function loadBoardFromBackend() {
            try {
                const response = await fetch('/load_board');
                const result = await response.json();
                if (result.status === 'success' && result.board_state) {
                    boardTiles = result.board_state.boardTiles;
                    PORT_DATA = result.board_state.portData;
                    robberTile = result.board_state.robberTile; // Load robber position
                    // If on builder page, save this loaded state to its history
                    if (!isGamePage && !isPlayerPage) {
                        saveBuilderState();
                    }
                    showMessage('Board state loaded successfully!');
                } else {
                    // If no saved board state, or an error, initialize with default values
                    showMessage((result.message || "No saved board state found.") + ' Displaying default board.', 'info');
                    boardTiles = [
                        // Row 0
                        { q: 0, r: -2, type: 'ore', number: 10 },
                        { q: 1, r: -2, type: 'sheep', number: 2 },
                        { q: 2, r: -2, type: 'wood', number: 9 },

                        // Row 1
                        { q: -1, r: -1, type: 'brick', number: 12 },
                        { q: 0, r: -1, type: 'wheat', number: 6 },
                        { q: 1, r: -1, type: 'ore', number: 4 },
                        { q: 2, r: -1, type: 'wood', number: 10 },

                        // Row 2
                        { q: -2, r: 0, type: 'wood', number: 9 },
                        { q: -1, r: 0, type: 'sheep', number: 11 },
                        { q: 0, r: 0, type: 'desert', number: null }, // Desert tile
                        { q: 1, r: 0, type: 'brick', number: 3 },
                        { q: 2, r: 0, type: 'wheat', number: 8 },

                        // Row 3
                        { q: -2, r: 1, type: 'ore', number: 8 },
                        { q: -1, r: 1, type: 'wheat', number: 3 },
                        { q: 0, r: 1, type: 'wood', number: 4 },
                        { q: 1, r: 1, type: 'sheep', number: 5 },

                        // Row 4
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
                    robberTile = boardTiles.find(tile => tile.type === 'desert'); // Default robber on desert
                    // If on builder page, save this default state to its history
                    if (!isGamePage && !isPlayerPage) {
                        saveBuilderState();
                    }
                }
                // Always re-initialize allJunctions and allEdges after boardTiles is set
                allJunctions = getAllJunctions();
                allEdges = getAllEdges();
                resizeCanvas(); // Resize and draw after board data is ready
            } catch (e) {
                showMessage('Network error loading board state: ' + e.message + '. Displaying default board.', 'error');
                console.error('Error loading board state from backend:', e);
                // On network error, ensure default board is still displayed
                boardTiles = [
                    // Row 0
                    { q: 0, r: -2, type: 'ore', number: 10 },
                    { q: 1, r: -2, type: 'sheep', number: 2 },
                    { q: 2, r: -2, type: 'wood', number: 9 },

                    // Row 1
                    { q: -1, r: -1, type: 'brick', number: 12 },
                    { q: 0, r: -1, type: 'wheat', number: 6 },
                    { q: 1, r: -1, type: 'ore', number: 4 },
                    { q: 2, r: -1, type: 'wood', number: 10 },

                    // Row 2
                    { q: -2, r: 0, type: 'wood', number: 9 },
                    { q: -1, r: 0, type: 'sheep', number: 11 },
                    { q: 0, r: 0, type: 'desert', number: null }, // Desert tile
                    { q: 1, r: 0, type: 'brick', number: 3 },
                    { q: 2, r: 0, type: 'wheat', number: 8 },

                    // Row 3
                    { q: -2, r: 1, type: 'ore', number: 8 },
                    { q: -1, r: 1, type: 'wheat', number: 3 },
                    { q: 0, r: 1, type: 'wood', number: 4 },
                    { q: 1, r: 1, type: 'sheep', number: 5 },

                    // Row 4
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
                robberTile = boardTiles.find(tile => tile.type === 'desert'); // Default robber on desert
                allJunctions = getAllJunctions();
                allEdges = getAllEdges();
                resizeCanvas(); // Always attempt to resize and draw
            }
        }

        /**
         * Saves the current player's state to the Flask backend.
         */
        async function savePlayerStateToBackend() {
            if (!PLAYER_ID) return; // Only save if a player ID is available

            try {
                const playerStateToSave = {
                    playerName: currentPlayerState.playerName,
                    roads: currentPlayerState.roads.map(road => ({ edge: road.edge.id, owner: road.owner })), // Save only edge ID
                    structures: currentPlayerState.structures.map(s => ({ type: s.type, junction: s.junction.id, owner: s.owner })), // Save only junction ID
                    hand: currentPlayerState.hand,
                    devCards: currentPlayerState.devCards,
                    // Note: history is not saved to backend to avoid large files,
                    // it's for client-side undo only.
                    robberTile: robberTile ? { q: robberTile.q, r: robberTile.r } : null // Robber position is saved with player state for simplicity for now
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
                    // showMessage(result.message); // Commented out to reduce message spam
                } else {
                    showMessage('Error saving player state: ' + result.message, 'error');
                }
            } catch (e) {
                showMessage('Network error saving player state: ' + e.message, 'error');
                console.error('Error saving player state to backend:', e);
            }
        }

        /**
         * Loads the current player's state from the Flask backend.
         */
        async function loadPlayerStateFromBackend() {
            if (!PLAYER_ID) return; // Only load if a player ID is available

            try {
                const response = await fetch(`/load_player_state/${PLAYER_ID}`);
                const result = await response.json();
                if (result.status === 'success' && result.player_state) {
                    const loadedState = result.player_state;
                    currentPlayerState.playerName = loadedState.playerName || `Player ${PLAYER_ID}`;
                    currentPlayerState.hand = loadedState.hand || {};
                    currentPlayerState.devCards = loadedState.devCards || [];

                    // Reconstruct roads and structures from IDs
                    // Ensure allEdges and allJunctions are populated BEFORE this step
                    currentPlayerState.roads = (loadedState.roads || []).map(r => ({
                        edge: allEdges.find(edge => edge.id === r.edge),
                        owner: r.owner
                    })).filter(r => r.edge); // Filter out any roads whose edges couldn't be found
                    currentPlayerState.structures = (loadedState.structures || []).map(s => ({
                        type: s.type,
                        junction: allJunctions.find(j => j.id === s.junction),
                        owner: s.owner
                    })).filter(s => s.junction); // Filter out any structures whose junctions couldn't be found

                    // Load robber position if present in player state (for simplicity, assuming one robber)
                    if (loadedState.robberTile) {
                        robberTile = boardTiles.find(t => t.q === loadedState.robberTile.q && t.r === loadedState.robberTile.r);
                    } else {
                        robberTile = boardTiles.find(tile => tile.type === 'desert'); // Default robber on desert
                    }

                    // Re-initialize player history after loading state
                    currentPlayerState.history = [];
                    savePlayerStateToHistory(); // Save the newly loaded state as the first history entry

                    updatePlayerUI(); // Update UI elements
                    showMessage(`Player ${PLAYER_ID} state loaded successfully!`);
                } else {
                    showMessage(`No saved state found for Player ${PLAYER_ID}. Initializing new player state.`, 'info');
                    // Initialize default state for new player
                    currentPlayerState = {
                        playerName: `Player ${PLAYER_ID}`,
                        roads: [],
                        structures: [],
                        hand: { 'wood': 0, 'brick': 0, 'sheep': 0, 'wheat': 0, 'ore': 0 }, // Example initial hand
                        devCards: [],
                        history: []
                    };
                    savePlayerStateToHistory(); // Save initial state to history
                    savePlayerStateToBackend(); // Save initial state to backend
                }
                drawBoard(); // Redraw board after player state is loaded/initialized
            } catch (e) {
                showMessage('Network error loading player state: ' + e.message, 'error');
                console.error('Error loading player state from backend:', e);
                // Even on error, ensure default player state is set and UI updated
                currentPlayerState = {
                    playerName: `Player ${PLAYER_ID}`,
                    roads: [],
                    structures: [],
                    hand: { 'wood': 0, 'brick': 0, 'sheep': 0, 'wheat': 0, 'ore': 0 },
                    devCards: [],
                    history: []
                };
                savePlayerStateToHistory();
                drawBoard();
                updatePlayerUI();
            }
        }


        /**
         * Calculates the pixel coordinates for all potential junctions on the board.
         * @returns {Array<{x: number, y: number, id: string}>} Array of junction objects.
         */
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

        /**
         * Calculates the pixel coordinates for all potential edges (road segments) on the board.
         * @returns {Array<{x1: number, y1: number, x2: number, y2: number, id: string}>} Array of edge objects.
         */
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

        /**
         * Finds the closest junction to a given pixel coordinate.
         * @param {number} px - Pixel X coordinate (from mouse event, canvas-relative).
         * @param {number} py - Pixel Y coordinate (from mouse event, canvas-relative).
         * @param {number} threshold - Maximum distance to consider a junction "hit".
         * @returns {object|null} The closest junction object or null if none within threshold.
         */
        function getClosestJunction(px, py, threshold = 20) {
            let closestJunction = null;
            let minDistance = Infinity;

            allJunctions.forEach(junction => {
                // Transform junction's raw coordinates to canvas-relative for comparison
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

        /**
         * Finds the closest edge to a given pixel coordinate.
         * @param {number} px - Pixel X coordinate (from mouse event, canvas-relative).
         * @param {number} py - Pixel Y coordinate (from mouse event, canvas-relative).
         * @param {number} threshold - Maximum distance to consider an edge "hit".
         * @returns {object|null} The closest edge object or null if none within threshold.
         */
        function getClosestEdge(px, py, threshold = 20) {
            let closestEdge = null;
            let minDistance = Infinity;

            allEdges.forEach(edge => {
                // Transform edge's raw coordinates to canvas-relative for comparison
                const edgeX1 = edge.x1 + offsetX;
                const edgeY1 = edge.y1 + offsetY;
                const edgeX2 = edge.x2 + offsetX;
                const edgeY2 = edge.y2 + offsetY;

                // Calculate distance from point to line segment
                const A = px - edgeX1;
                const B = py - edgeY1;
                const C = edgeX2 - edgeX1;
                const D = edgeY2 - edgeY1;

                const dot = A * C + B * D;
                const len_sq = C * C + D * D;
                let param = -1;
                if (len_sq != 0) { // In case of 0 length line
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

        /**
         * Checks if a point (px, py) is inside the number circle of a given tile.
         * @param {number} px - Click X coordinate.
         * @param {number} py - Click Y coordinate.
         * @param {object} tile - The tile object.
         * @returns {boolean} True if inside the number circle, false otherwise.
         */
        function isPointInNumberCircle(px, py, tile) {
            if (tile.number === null) return false; // Desert tile has no number

            const pixel = hexToPixel(tile.q, tile.r);
            const dist = Math.sqrt(Math.pow(px - pixel.x, 2) + Math.pow(py - pixel.y, 2));
            return dist < NUMBER_RADIUS;
        }


        /**
         * Handles clicks on the canvas to place elements.
         * @param {MouseEvent} event - The click event.
         */
        canvas.addEventListener('click', (event) => {
            const rect = canvas.getBoundingClientRect();
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;
            const mouseX = (event.clientX - rect.left) * scaleX;
            const mouseY = (event.clientY - rect.top) * scaleY;

            let actionSuccessful = false;

            if (!isGamePage && !isPlayerPage) { // Builder page logic
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
            } else if (isPlayerPage) { // Player page logic for placing elements
                // savePlayerStateToHistory(); // Save state before potential modification - moved inside specific actions

                if (selectedPlayerTool === 'house') {
                    const clickedJunction = getClosestJunction(mouseX, mouseY);
                    if (clickedJunction) {
                        // Check if a structure already exists at this junction (any player)
                        const existingStructure = currentPlayerState.structures.find(s => s.junction.id === clickedJunction.id); // This needs to check ALL players' structures
                        // For now, it only checks current player's structures, which is fine for initial single player
                        if (existingStructure) {
                            showMessage('A structure already exists here.', 'error');
                        } else {
                            savePlayerStateToHistory(); // Save state before modifying
                            currentPlayerState.structures.push({ type: 'house', junction: clickedJunction, owner: PLAYER_ID });
                            showMessage('House placed!');
                            actionSuccessful = true;
                        }
                    } else {
                        showMessage('Click near a junction to place a house.', 'error');
                    }
                } else if (selectedPlayerTool === 'city') {
                    const clickedJunction = getClosestJunction(mouseX, mouseY);
                    if (clickedJunction) {
                        // Check if a house exists at this junction, owned by current player
                        const existingHouse = currentPlayerState.structures.find(s => s.junction.id === clickedJunction.id && s.type === 'house' && s.owner === PLAYER_ID);
                        if (existingHouse) {
                            savePlayerStateToHistory(); // Save state before modifying
                            existingHouse.type = 'city'; // Upgrade house to city
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
                        // Check if a road already exists on this edge (any player)
                        const existingRoad = currentPlayerState.roads.find(r => r.edge.id === clickedEdge.id); // This needs to check ALL players' roads
                        // For now, it only checks current player's roads, which is fine for initial single player
                        if (existingRoad) {
                            showMessage('A road already exists here.', 'error');
                        } else {
                            savePlayerStateToHistory(); // Save state before modifying
                            currentPlayerState.roads.push({ edge: clickedEdge, owner: PLAYER_ID });
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
                        if (clickedTile.type === 'desert') {
                            showMessage('Cannot place robber on desert tile. Robber is already there by default.', 'error');
                        } else if (robberTile && robberTile.q === clickedTile.q && robberTile.r === clickedTile.r) {
                            showMessage('Robber is already on this tile.', 'info');
                        } else {
                            savePlayerStateToHistory(); // Save state before modifying
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
                    savePlayerStateToBackend(); // Save player state to backend after action
                } else if (!isGamePage && !isPlayerPage) { // Builder page
                    // saveBuilderState() is called by individual builder functions like shuffle, undo
                    // No need to call here for click actions like swap, as it's handled within swap logic
                }
            }
            drawBoard(); // Redraw board after any change
        });


        // Event listeners for control buttons (Builder Page)
        if (!isGamePage && !isPlayerPage) { // Only attach these listeners on the builder page
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

        // Event listeners for player page specific controls
        if (isPlayerPage) { // Only attach these listeners on player pages
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
                        // For other tools like house, city, road, robber, the click handler on canvas will take over
                        showMessage(`Selected tool: ${selectedPlayerTool}. Click on the board to place.`);
                    }
                }
            });

            // Card action buttons (for future implementation, just show message for now)
            document.querySelector('.card-buttons').addEventListener('click', (event) => {
                const target = event.target;
                if (target.classList.contains('btn-tool')) {
                    const action = target.dataset.tool;
                    showMessage(`Action: ${action} (To be implemented)`);
                    // Example: Add a resource card for testing
                    if (action === 'get-dev-card') {
                        // For demonstration, let's add a random resource
                        const resources = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
                        const randomResource = resources[Math.floor(Math.random() * resources.length)];
                        currentPlayerState.hand[randomResource] = (currentPlayerState.hand[randomResource] || 0) + 1;
                        updatePlayerUI();
                        savePlayerStateToBackend();
                        showMessage(`Got 1 ${randomResource} card.`);
                    }
                }
            });
        }


        /**
         * Resizes the canvas and recalculates offsets to center the board.
         */
        function resizeCanvas() {
            const containerWidth = canvas.parentElement.clientWidth;
            const containerHeight = canvas.parentElement.clientHeight;

            // Set canvas dimensions based on container, maintaining aspect ratio
            const aspectRatio = 1.2 / 1; // Width / Height
            let newWidth = containerWidth;
            let newHeight = newWidth / aspectRatio;

            if (newHeight > containerHeight) {
                newHeight = containerHeight;
                newWidth = newHeight * aspectRatio;
            }

            canvas.width = newWidth;
            canvas.height = newHeight;

            // Calculate raw bounding box of the hex tiles to determine true board dimensions
            let minRawX = Infinity, maxRawX = -Infinity, minRawY = Infinity, maxRawY = -Infinity;
            if (boardTiles.length > 0) { // Only calculate if boardTiles has data
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

                // Calculate offset to center the board within the canvas
                offsetX = (canvas.width / 2) - (minRawX + boardActualWidth / 2);
                offsetY = (canvas.height / 2) - (minRawY + boardActualHeight / 2);

                // Store global board center for port calculations
                boardCenterRawX = minRawX + boardActualWidth / 2;
                boardCenterRawY = minRawY + boardActualHeight / 2;
            } else {
                // If no tiles, center at 0,0 and set offsets to canvas center
                offsetX = canvas.width / 2;
                offsetY = canvas.height / 2;
                boardCenterRawX = 0;
                boardCenterRawY = 0;
            }

            drawBoard();
        }

        /**
         * Updates the player-specific UI elements (name, hand, dev cards).
         */
        function updatePlayerUI() {
            if (!isPlayerPage) return;

            // Update player name display
            const playerNameInput = document.getElementById('playerNameInput');
            const playerNameDisplay = document.getElementById('playerNameDisplay');
            if (playerNameInput) playerNameInput.value = currentPlayerState.playerName;
            if (playerNameDisplay) playerNameDisplay.textContent = currentPlayerState.playerName;


            // Update hand cards display
            const handCardsDiv = document.getElementById('handCards');
            if (handCardsDiv) {
                handCardsDiv.innerHTML = ''; // Clear existing cards
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


            // Update dev cards display
            const devCardsDiv = document.getElementById('devCards');
            if (devCardsDiv) {
                devCardsDiv.innerHTML = ''; // Clear existing cards
                currentPlayerState.devCards.forEach(card => {
                    const cardItem = document.createElement('div');
                    cardItem.classList.add('card-item');
                    cardItem.textContent = card.charAt(0).toUpperCase() + card.slice(1);
                    devCardsDiv.appendChild(cardItem);
                });
                document.getElementById('devCardCount').textContent = currentPlayerState.devCards.length;
            }
        }


        /**
         * Function to be called specifically when a Catan Player page loads.
         * This ensures player-specific data is loaded after the board map.
         */
        async function onCatanPlayerPageLoad() {
            console.log(`Catan Player ${PLAYER_ID} page has loaded.`);
            // Load player-specific state AFTER the main board data is available
            await loadPlayerStateFromBackend();
            updatePlayerUI(); // Update UI with loaded player data
            // Initial save of player state to history (after loading from backend or initializing)
            // This ensures the first "undo" works correctly if no prior state was saved
            savePlayerStateToHistory();
        }


        // Initial setup and resize on load (common to all pages)
        window.addEventListener('load', async () => {
            // First, preload images and load the main board state (tiles, ports, robber)
            await preloadImages();
            // loadBoardFromBackend() is called by preloadImages() once images are ready.
            // After loadBoardFromBackend completes, allJunctions and allEdges are initialized.

            if (!isGamePage && !isPlayerPage) { // Builder page specific actions
                // saveBuilderState() is already called within loadBoardFromBackend for builder page
                // to save the initial state for undo.
            } else if (isPlayerPage) { // Player page specific actions
                onCatanPlayerPageLoad(); // Call player-specific load function
            }
            // No specific action needed for isGamePage (viewer) here, as loadBoardFromBackend already draws it.
        });
        window.addEventListener('resize', resizeCanvas);
