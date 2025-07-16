        const canvas = document.getElementById('catanBoard');
        const ctx = canvas.getContext('2d');
        const messageBox = document.getElementById('messageBox');

        // Constants for board drawing
        const HEX_SIZE = 80; // Size of a hexagon (distance from center to a vertex)
        const TILE_RADIUS = HEX_SIZE; // Cells now touch each other
        const NUMBER_RADIUS = HEX_SIZE * 0.3; // Radius for the number circles
        const ROAD_WIDTH = 12;
        const HOUSE_SIZE = 20;
        const CITY_SIZE = 30;
        const PORT_SIZE = HEX_SIZE * 0.3; // Increased size for port icons/text

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
        const ROBBER_COLOR = '#333'; // Robber is not used on this page, but kept for consistency

        // Image paths for resources (using placehold.co for placeholders)
        const resourceImagePaths = {
            'wood': 'https://placehold.co/200x200/3CB371/ffffff?text=Forest',
            'brick': 'https://placehold.co/200x200/CD5C5C/ffffff?text=Brickfield',
            'sheep': 'https://placehold.co/200x200/90EE90/000000?text=Sheep+Field',
            'wheat': 'https://placehold.co/200x200/DAA520/ffffff?text=Hay+Field',
            'ore': 'https://placehold.co/200x200/708090/ffffff?text=Rocky+Mountain',
            'desert': 'https://placehold.co/200x200/F4A460/ffffff?text=Desert'
        };
        const loadedResourceImages = {}; // Stores loaded Image objects

        // Game state (only relevant parts for main page map setup)
        let selectedTool = 'swap'; // Default tool for this page
        let placedRoads = []; // Not used on this page, but kept for consistency with history structure
        let placedStructures = []; // Not used on this page, but kept for consistency with history structure
        let robberTile = null; // Not used on this page, but kept for consistency with history structure

        // History stack for undo functionality
        let historyStack = [];

        // State for swap functionality
        let selectedSwapItem1 = null; // { type: 'number' | 'tile', tile: {q, r} }
        let selectedSwapItem2 = null;

        // Board layout (axial coordinates q, r) and resource types/numbers
        const boardTiles = [
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

        // Global offset to center the board
        let offsetX = 0;
        let offsetY = 0;

        // Global board center (raw pixel coordinates) for calculating outward vectors for ports
        let boardCenterRawX = 0;
        let boardCenterRawY = 0;

        // Array/list for defining port text and background. Each entry corresponds to a perimeter junction.
        // There are typically 30 junctions around a standard Catan board.
        // Format: ['resource_type' (e.g., 'wood', 'brick', 'any'), 'ratio_text' (e.g., '2:1', '3:1')]
        // Use null or an empty array for invisible ports.
        const PORT_DATA = [
            null, // Placeholder for first few junctions, make them invisible
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            ['wood', '2:1'], // Example specific port
            ['brick', '2:1'], // Example specific port
            ['sheep', '2:1'], // Example specific port
            null,
            null,
            ['any', '3:1'], // Example generic 3:1 port
            null,
            null,
            ['wheat', '2:1'], // Example specific port
            null,
            null,
            ['any', '3:1'],
            null,
            null,
            ['ore', '2:1'], // Example specific port
            null,
            ['any', '3:1'],
            null,
            null,
            ['any', '3:1'],
            null,
            null
        ];


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
            }, 3000); // Hide after 3 seconds
        }

        /**
         * Preloads all resource images.
         * Calls drawBoard once all images are loaded.
         */
        function preloadImages() {
            let imagesToLoad = Object.keys(resourceImagePaths).length;
            if (imagesToLoad === 0) {
                resizeCanvas(); // Draw immediately if no images
                return;
            }

            for (const type in resourceImagePaths) {
                const img = new Image();
                img.src = resourceImagePaths[type];
                img.onload = () => {
                    loadedResourceImages[type] = img;
                    imagesToLoad--;
                    if (imagesToLoad === 0) {
                        resizeCanvas(); // All images loaded, draw the board
                    }
                };
                img.onerror = () => {
                    console.error(`Failed to load image for ${type}: ${resourceImagePaths[type]}`);
                    // Fallback to solid color if image fails to load
                    loadedResourceImages[type] = null;
                    imagesToLoad--;
                    if (imagesToLoad === 0) {
                        resizeCanvas();
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

            ctx.save(); // Save context state before clipping
            ctx.clip(); // Clip subsequent drawing to the hexagon path

            if (image && image.complete && image.naturalWidth > 0) {
                // Calculate scale to cover the hexagon
                const hexWidth = size * 2; // Approximate diameter
                const hexHeight = size * Math.sqrt(3); // Approximate height
                const scaleX = hexWidth / image.naturalWidth;
                const scaleY = hexHeight / image.naturalHeight;
                const scale = Math.max(scaleX, scaleY); // Use max to ensure it covers the hex

                const imgWidth = image.naturalWidth * scale;
                const imgHeight = image.naturalHeight * scale;

                // Center the image within the hexagon
                ctx.drawImage(image, x - imgWidth / 2, y - imgHeight / 2, imgWidth, imgHeight);
            } else {
                ctx.fillStyle = fillColor;
                ctx.fill();
            }
            ctx.restore(); // Restore context to remove clipping

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
            if (number === null) return; // No number for desert

            ctx.beginPath();
            ctx.arc(x, y, NUMBER_RADIUS, 0, Math.PI * 2);

            // Change background and text color for 6 and 8
            if (number === 6 || number === 8) {
                ctx.fillStyle = 'red';
                ctx.fill();
                ctx.strokeStyle = '#666';
                ctx.lineWidth = 1;
                ctx.stroke();
                ctx.fillStyle = 'white'; // White text for red background
            } else {
                ctx.fillStyle = '#FFFAF0'; // Ivory background for other numbers
                ctx.fill();
                ctx.strokeStyle = '#666';
                ctx.lineWidth = 1;
                ctx.stroke();
                ctx.fillStyle = NUMBER_COLOR; // Default text color
            }

            ctx.font = `bold ${NUMBER_RADIUS * 0.8}px Inter`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(number, x, y - NUMBER_RADIUS * 0.25); // Adjust Y to make space for dots

            // Draw pips (dots) based on probability
            let numDots = 0;
            switch (number) {
                case 2:
                case 12:
                    numDots = 1;
                    break;
                case 3:
                case 11:
                    numDots = 2;
                    break;
                case 4:
                case 10:
                    numDots = 3;
                    break;
                case 5:
                case 9:
                    numDots = 4;
                    break;
                case 6:
                case 8:
                    numDots = 5;
                    break;
                default:
                    numDots = 0; // Desert or other numbers
            }

            const dotRadius = NUMBER_RADIUS * 0.08;
            const dotSpacing = NUMBER_RADIUS * 0.2;
            const startX = x - ((numDots - 1) * dotSpacing) / 2;
            const dotY = y + NUMBER_RADIUS * 0.35; // Position dots below the number

            ctx.fillStyle = (number === 6 || number === 8) ? 'white' : NUMBER_COLOR; // White dots for red background, else default
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
            ctx.fillStyle = '#8B4513'; // SaddleBrown
            ctx.fillRect(x - iconSize * 0.2, y - iconSize * 0.2, iconSize * 0.4, iconSize * 0.4);
            ctx.strokeStyle = '#654321';
            ctx.lineWidth = 1;
            ctx.strokeRect(x - iconSize * 0.2, y - iconSize * 0.2, iconSize * 0.4, iconSize * 0.4);
        }

        /**
         * Draws a stylized brick icon for ports.
         */
        function drawBrickPortIcon(ctx, x, y, iconSize) {
            ctx.fillStyle = '#B22222'; // Firebrick
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
            ctx.fillStyle = '#F0F8FF'; // AliceBlue
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
            ctx.fillStyle = '#FFD700'; // Gold
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
            ctx.fillStyle = '#A9A9A9'; // DarkGray
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

            // Draw circle background
            const circleRadius = PORT_SIZE; // Use PORT_SIZE directly for radius
            ctx.beginPath();
            ctx.arc(0, 0, circleRadius, 0, Math.PI * 2);

            // Optional: Draw background image if provided
            if (backgroundImage && backgroundImage.complete && backgroundImage.naturalWidth > 0) {
                // Scale and draw image to cover the circle
                const imgScale = Math.max(circleRadius * 2 / backgroundImage.naturalWidth, circleRadius * 2 / backgroundImage.naturalHeight);
                const imgWidth = backgroundImage.naturalWidth * imgScale;
                const imgHeight = backgroundImage.naturalHeight * imgScale;
                ctx.clip(); // Clip to circle shape
                ctx.drawImage(backgroundImage, -imgWidth / 2, -imgHeight / 2, imgWidth, imgHeight);
            } else {
                ctx.fillStyle = '#D3D3D3'; // Light gray fallback
                ctx.fill();
            }

            ctx.strokeStyle = '#666';
            ctx.lineWidth = 1;
            ctx.stroke();

            // Draw resource icon or generic icon
            const iconSize = PORT_SIZE * 0.6;
            const iconYOffset = -circleRadius * 0.3; // Adjust icon Y position to be higher in the circle
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

            // Draw ratio text
            ctx.fillStyle = '#333';
            ctx.font = `bold ${PORT_SIZE * 0.4}px Inter`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const ratioYOffset = circleRadius * 0.3; // Adjust ratio Y position to be lower in the circle
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
            // Apply offset before drawing
            ctx.moveTo(edge.x1 + offsetX, edge.y1 + offsetY);
            ctx.lineTo(edge.x2 + offsetX, edge.y2 + offsetY);
            ctx.strokeStyle = color;
            ctx.lineWidth = ROAD_WIDTH;
            ctx.lineCap = 'butt'; // Ensures precise alignment without rounded overhang
            ctx.stroke();
        }

        /**
         * Draws a house on the canvas with more detail.
         * @param {CanvasRenderingContext2D} ctx - The canvas rendering context.
         * @param {object} junction - The junction object with raw pixel coordinates.
         * @param {string} color - Color of the house.
         */
        function drawHouse(ctx, junction, color) {
            // Apply offset before drawing
            const x = junction.x + offsetX;
            const y = junction.y + offsetY;
            const size = HOUSE_SIZE;

            ctx.fillStyle = color;
            ctx.strokeStyle = '#333';
            ctx.lineWidth = 2;

            // Main body
            ctx.fillRect(x - size / 2, y - size / 2, size, size);
            ctx.strokeRect(x - size / 2, y - size / 2, size, size);

            // Roof
            ctx.beginPath();
            ctx.moveTo(x - size * 0.7, y - size / 2);
            ctx.lineTo(x + size * 0.7, y - size / 2);
            ctx.lineTo(x, y - size * 1.2);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            // Door
            ctx.fillStyle = '#8B4513'; // Brown
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
            // Apply offset before drawing
            const x = junction.x + offsetX;
            const y = junction.y + offsetY;
            const size = CITY_SIZE;

            ctx.fillStyle = color;
            ctx.strokeStyle = '#333';
            ctx.lineWidth = 2;

            // Main castle body
            ctx.fillRect(x - size / 2, y - size / 2, size, size);
            ctx.strokeRect(x - size / 2, y - size / 2, size, size);

            // Towers
            ctx.fillRect(x - size * 0.4, y - size * 1.1, size * 0.3, size * 0.6); // Left tower
            ctx.strokeRect(x - size * 0.4, y - size * 1.1, size * 0.3, size * 0.6);

            ctx.fillRect(x + size * 0.1, y - size * 1.1, size * 0.3, size * 0.6); // Right tower
            ctx.strokeRect(x + size * 0.1, y - size * 1.1, size * 0.3, size * 0.6);

            // Battlements on main body
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
            const pixel = hexToPixel(tile.q, tile.r); // hexToPixel already applies offset
            const x = pixel.x;
            const y = pixel.y;
            const robberSize = HEX_SIZE * 0.3;

            ctx.fillStyle = ROBBER_COLOR;
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 2;

            ctx.beginPath();
            // Base
            ctx.arc(x, y + robberSize * 0.4, robberSize * 0.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            // Body
            ctx.beginPath();
            ctx.moveTo(x - robberSize * 0.3, y + robberSize * 0.4);
            ctx.lineTo(x - robberSize * 0.3, y - robberSize * 0.1);
            ctx.arc(x, y - robberSize * 0.1, robberSize * 0.3, Math.PI, 0, true);
            ctx.lineTo(x + robberSize * 0.3, y + robberSize * 0.4);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            // Head
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
                // Check if the junction's raw coordinates are approximately equal to any of the tile's raw vertex coordinates
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
            ctx.clearRect(0, 0, canvas.width, canvas.height); // Clear canvas

            // Draw all board tiles
            boardTiles.forEach(tile => {
                const pixel = hexToPixel(tile.q, tile.r);
                const image = loadedResourceImages[tile.type]; // Get the loaded image
                drawHex(ctx, pixel.x, pixel.y, TILE_RADIUS, RESOURCE_COLORS[tile.type], image); // Pass image
                // Only draw number on tiles with numbers
                if (tile.number !== null) {
                    drawNumber(ctx, pixel.x, pixel.y, tile.number);
                }
            });

            // Draw all placed roads (not relevant for this page, but kept for history structure)
            placedRoads.forEach(road => {
                drawRoad(ctx, road.edge, road.color);
            });

            // Draw all placed structures (not relevant for this page, but kept for history structure)
            placedStructures.forEach(structure => {
                if (structure.type === 'house') {
                    drawHouse(ctx, structure.junction, structure.color);
                } else if (structure.type === 'city') {
                    drawCity(ctx, structure.junction, structure.color);
                }
            });

            // Draw robber if placed (not relevant for this page, but kept for consistency with history structure)
            if (robberTile) {
                drawRobber(ctx, robberTile);
            }

            // Draw circular ports for all perimeter junctions
            const perimeterJunctions = allJunctions.filter(junction => countTilesForJunction(junction) < 3);

            perimeterJunctions.forEach((junction, index) => {
                // Get port data from the PORT_DATA array
                const portInfo = PORT_DATA[index];

                // Only draw the port if portInfo exists and is not null/empty
                if (portInfo && portInfo.length === 2) {
                    const [type, ratio] = portInfo;

                    // Convert raw junction coords to canvas coords
                    const junctionX = junction.x + offsetX;
                    const junctionY = junction.y + offsetY;

                    // Vector from board center to this junction
                    const vecX = junctionX - (boardCenterRawX + offsetX);
                    const vecY = junctionY - (boardCenterRawY + offsetY);
                    const vecMagnitude = Math.sqrt(vecX * vecX + vecY * vecY);

                    const offsetDistance = HEX_SIZE * 0.4; // How far out to push the circle
                    const portDrawX = junctionX + (vecX / vecMagnitude) * offsetDistance;
                    const portDrawY = junctionY + (vecY / vecMagnitude) * offsetDistance;

                    // Draw the circular port
                    // You can pass an optional background image here if you implement loading them.
                    drawCirclePort(ctx, portDrawX, portDrawY, type, ratio, null);
                }
            });


            // Draw highlights for selected tiles/numbers during swap
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

        /**
         * Saves the current state of the board to the history stack.
         */
        function saveState() {
            // Deep copy the arrays and objects to prevent direct reference issues
            historyStack.push({
                roads: JSON.parse(JSON.stringify(placedRoads)),
                structures: JSON.parse(JSON.stringify(placedStructures)),
                robber: robberTile ? JSON.parse(JSON.stringify(robberTile)) : null,
                // Save the full state of all boardTiles (type and number) for swap undo
                tileStates: boardTiles.map(tile => ({ q: tile.q, r: tile.r, type: tile.type, number: tile.number }))
            });
            // Optional: Limit history stack size if it grows too large
            // if (historyStack.length > 50) {
            //     historyStack.shift(); // Remove the oldest state
            // }
        }

        /**
         * Undoes the last action by restoring the previous state from the history stack.
         */
        function undoLastAction() {
            if (historyStack.length > 1) { // Keep at least one state (the initial empty board)
                historyStack.pop(); // Remove the current state
                const prevState = historyStack[historyStack.length - 1]; // Get the previous state
                placedRoads = JSON.parse(JSON.stringify(prevState.roads));
                placedStructures = JSON.parse(JSON.stringify(prevState.structures));
                robberTile = prevState.robber ? JSON.parse(JSON.stringify(prevState.robber)) : null;

                // Restore tile types and numbers
                prevState.tileStates.forEach(prevTile => {
                    const currentTile = boardTiles.find(t => t.q === prevTile.q && t.r === prevTile.r);
                    if (currentTile) {
                        currentTile.type = prevTile.type;
                        currentTile.number = prevTile.number;
                    }
                });

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
         * Shuffles the resource types (cells) on the board, keeping the desert tile fixed.
         */
        function shuffleCells() {
            saveState(); // Save state before shuffling

            const nonDesertTiles = boardTiles.filter(tile => tile.type !== 'desert');
            // No need to get desertTile separately, as it's filtered out

            const resourceTypes = nonDesertTiles.map(tile => tile.type);
            shuffleArray(resourceTypes);

            // Reassign shuffled types to non-desert tiles
            nonDesertTiles.forEach((tile, index) => {
                tile.type = resourceTypes[index];
            });

            showMessage('Cells shuffled!');
            drawBoard();
        }

        /**
         * Shuffles the numbers on the board, keeping the desert tile's number null.
         */
        function shuffleNumbers() {
            saveState(); // Save state before shuffling

            const nonDesertTiles = boardTiles.filter(tile => tile.type !== 'desert');
            const numbers = nonDesertTiles.map(tile => tile.number);
            shuffleArray(numbers);

            // Reassign shuffled numbers to non-desert tiles
            nonDesertTiles.forEach((tile, index) => {
                tile.number = numbers[index];
            });

            showMessage('Numbers shuffled!');
            drawBoard();
        }

        /**
         * Saves the current board state to the Flask backend.
         */
        async function saveBoardToBackend() {
            try {
                const boardState = boardTiles.map(tile => ({
                    q: tile.q,
                    r: tile.r,
                    type: tile.type,
                    number: tile.number
                }));
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
         * Loads the board state from the Flask backend.
         */
        async function loadBoardFromBackend() {
            try {
                const response = await fetch('/load_board');
                const result = await response.json();
                if (result.status === 'success' && result.board_state) {
                    saveState(); // Save current state before loading a new one for undo
                    const loadedTiles = result.board_state;
                    // Update boardTiles with loaded data
                    loadedTiles.forEach(loadedTile => {
                        const currentTile = boardTiles.find(t => t.q === loadedTile.q && t.r === loadedTile.r);
                        if (currentTile) {
                            currentTile.type = loadedTile.type;
                            currentTile.number = loadedTile.number;
                        }
                    });
                    showMessage('Board state loaded successfully!');
                    drawBoard();
                } else if (result.status === 'info') {
                    showMessage(result.message, 'info');
                } else {
                    showMessage('Error loading board state: ' + result.message, 'error');
                }
            } catch (e) {
                showMessage('Network error loading board state: ' + e.message, 'error');
                console.error('Error loading board state from backend:', e);
            }
        }


        /**
         * Calculates the pixel coordinates for all potential junctions on the board.
         * @returns {Array<{x: number, y: number, id: string}>} Array of junction objects.
         */
        function getAllJunctions() {
            const junctions = new Map(); // Use Map to store unique junctions by a string key

            boardTiles.forEach(tile => { // Iterate over all tiles (inner and border)
                const rawPixel = hexToRawPixel(tile.q, tile.r); // Use raw pixel for consistent junction calculation
                const vertices = getHexVertices(rawPixel.x, rawPixel.y, TILE_RADIUS);
                vertices.forEach(v => {
                    // Create a unique ID for each junction based on rounded coordinates
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
            const edges = new Map(); // Use Map to store unique edges

            boardTiles.forEach(tile => { // Iterate over all tiles (inner and border)
                const rawPixel = hexToRawPixel(tile.q, tile.r); // Use raw pixel for consistent edge calculation
                const vertices = getHexVertices(rawPixel.x, rawPixel.y, TILE_RADIUS);
                for (let i = 0; i < 6; i++) {
                    const v1 = vertices[i];
                    const v2 = vertices[(i + 1) % 6];
                    // Create a canonical ID for each edge to avoid duplicates
                    // Sort coordinates to ensure (x1,y1)-(x2,y2) is same as (x2,y2)-(x1,y1)
                    const id1 = `${Math.round(v1.x)},${Math.round(v1.y)}`;
                    const id2 = `${Math.round(v2.x)},${Math.round(v2.y)}`;
                    const edgeId = [id1, id2].sort().join('-'); // Canonical ID

                    if (!edges.has(edgeId)) {
                        edges.set(edgeId, { x1: v1.x, y1: v1.y, x2: v2.x, y2: v2.y, id: edgeId });
                    }
                }
            });
            return Array.from(edges.values());
        }

        // Initialize allJunctions and allEdges after hexToRawPixel is defined
        const allJunctions = getAllJunctions();
        const allEdges = getAllEdges();

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

            let actionSuccessful = false; // Flag to track if a valid action occurred

            // Only swap functionality is active for clicks on the board
            if (selectedTool === 'swap') {
                const clickedHex = pixelToHex(mouseX, mouseY);
                const clickedTile = boardTiles.find(t => t.q === clickedHex.q && t.r === clickedHex.r);

                if (clickedTile) { // Can swap on any board tile
                    const isNumberClick = isPointInNumberCircle(mouseX, mouseY, clickedTile);
                    const currentSelectionType = isNumberClick ? 'number' : 'tile';

                    if (clickedTile.type === 'desert' && isNumberClick) {
                        showMessage('Cannot swap numbers on a desert tile.', 'error');
                        // Do not proceed with selection
                    } else if (!selectedSwapItem1) {
                        // First selection
                        selectedSwapItem1 = { type: currentSelectionType, tile: clickedTile };
                        showMessage(`First ${currentSelectionType} selected. Click another ${currentSelectionType} to swap.`);
                    } else if (selectedSwapItem1.tile.q === clickedTile.q && selectedSwapItem1.tile.r === clickedTile.r) {
                        // Deselect if clicking the same item again
                        showMessage(`${selectedSwapItem1.type} deselected. Start new selection.`, 'info');
                        selectedSwapItem1 = null;
                        selectedSwapItem2 = null;
                    } else if (selectedSwapItem1.type !== currentSelectionType) {
                        // Mismatch in selection type, restart selection
                        showMessage(`Cannot swap a ${selectedSwapItem1.type} with a ${currentSelectionType}. Please select two of the same type.`, 'error');
                        selectedSwapItem1 = { type: currentSelectionType, tile: clickedTile }; // Start new selection
                        selectedSwapItem2 = null;
                    }
                    else {
                        // Second selection, perform swap
                        selectedSwapItem2 = { type: currentSelectionType, tile: clickedTile };

                        if (selectedSwapItem1.type === 'number') {
                            // Swap numbers
                            const tempNumber = selectedSwapItem1.tile.number;
                            selectedSwapItem1.tile.number = selectedSwapItem2.tile.number;
                            selectedSwapItem2.tile.number = tempNumber;
                            showMessage('Numbers swapped successfully!');
                        } else if (selectedSwapItem1.type === 'tile') {
                            // Swap entire tiles (type and number)
                            const tempType = selectedSwapItem1.tile.type;
                            const tempNumber = selectedSwapItem1.tile.number;

                            selectedSwapItem1.tile.type = selectedSwapItem2.tile.type;
                            selectedSwapItem1.tile.number = selectedSwapItem2.tile.number;

                            selectedSwapItem2.tile.type = tempType;
                            selectedSwapItem2.tile.number = tempNumber;
                            showMessage('Tiles swapped successfully!');
                        }
                        actionSuccessful = true;
                        selectedSwapItem1 = null; // Clear selections after successful swap
                        selectedSwapItem2 = null;
                    }
                } else {
                    showMessage('Click on a resource tile to select for swap.', 'error');
                    selectedSwapItem1 = null; // Clear any partial selection
                    selectedSwapItem2 = null;
                }
            }

            if (actionSuccessful) {
                saveState(); // Save state only if a valid action was performed
            }
            drawBoard(); // Redraw board after any change
        });

        // Event listeners for control buttons
        document.getElementById('tool-select').addEventListener('click', (event) => {
            const target = event.target;
            if (target.classList.contains('btn-tool')) {
                // Deselect all tool buttons first
                document.querySelectorAll('.btn-tool').forEach(btn => btn.classList.remove('selected'));
                // Add 'selected' to the clicked button
                target.classList.add('selected');

                selectedTool = target.dataset.tool; // Update selectedTool for click handler

                // Handle specific button actions
                if (selectedTool === 'undo') {
                    undoLastAction();
                } else if (selectedTool === 'shuffle-cells') {
                    shuffleCells();
                } else if (selectedTool === 'shuffle-numbers') {
                    shuffleNumbers();
                } else if (selectedTool === 'save-board') {
                    saveBoardToBackend(); // Call backend save
                } else if (selectedTool === 'load-board') {
                    loadBoardFromBackend(); // Call backend load
                }
                // For 'swap', just update selectedTool and redraw
                showMessage(`Selected tool: ${selectedTool}`);
                drawBoard(); // Redraw to clear swap highlights if tool changes or for new state
            }
        });

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

            drawBoard();
        }

        // Initial setup and resize on load
        window.addEventListener('load', () => {
            preloadImages(); // Start preloading images and then call resizeCanvas/drawBoard
            saveState(); // Save the initial empty board state
        });
        window.addEventListener('resize', resizeCanvas);
