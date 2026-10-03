# Catan

This app provides a shared Base Catan board and player tracker. It is designed to support an in-person game; players still apply the tabletop rules and coordinate actions with each other.

## Start the app

From the repository root, install the Python dependencies and start the Flask-SocketIO server:

```powershell
pip install -r requirements.txt
python app.py
```

Open these pages on the server, replacing `localhost` with the server's address when connecting from another device:

- Board builder: <http://localhost:5000/catan_board>
- Player seats and sign-in: <http://localhost:5000/catan_player/>
- Shared game overview: <http://localhost:5000/catan_game>

## Start a game

1. Open the board builder before players join. Use **Shuffle Cells**, **Shuffle Numbers**, or **Swap Tiles/Numbers** to arrange the board. Board edits are saved automatically. Once a player seat is registered, the board is locked until the game is reset.
2. Each player opens the player page, enters a name and passphrase, and chooses an available placement color the first time they sign in. There are four seats. Players need their passphrase to reopen their player page.
3. Keep the shared game overview open to see the board, turn information, player scores, and game activity.

## Play

1. At the start of a turn, the current player presses the dice button on their player page. Only the active player can roll. The app advances the active-player marker as soon as the roll is made, so agree to finish the current player's actions before the next player rolls.
2. Apply the dice result using the tabletop rules. On the player page, click the resource cards to stage the resources earned, then choose **Take cards**. Resource production is not distributed automatically by the app.
3. To build, select **House**, **Road**, or **City** in the action toolbar, then click the appropriate spot on the board. The app checks the supported building costs and placement constraints; a city upgrades one of your existing houses.
4. To buy a development card, click **Dev Card** and confirm. Click a card in your hand to play it, following any prompt shown by the app.
5. To trade or give cards, select cards in your hand and choose a player's transfer control. Follow the tabletop rules for agreeing on trades.

The player page is intended to be used by each player on their own device. The game overview is shared and updates as players make changes.

## Reset and limitations

Choose **Reset Game** in the board builder to clear player seats and game state and unlock board editing. The saved board layout is retained.

This is the Base Catan tracker; Cities & Knights rules and components are not implemented yet. The app does not automatically distribute resources after a dice roll, so players must enter production themselves.

## todo 
give player the cards they will get . 
https://www.catan.com/sites/default/files/2021-06/catan_c_k_2020_rule_book_200708.pdf


reorder pick card
5 + 3 dev + 3 commodity + vicotry point

add knight 1 2 3 level.
has to show active and inactive. 
click on city should prompt for downgrade. 
click on knight prompt for activate if inactive or upgrade.or move or remove. 
knight move should make it inactive
can not have more than 2 1 level or 2 level or 3 level knight. total max 6 knight. 
level 3 can not just be placed. 
clicking road should show the option to remove the road. no change of card. 


summary table should have active knight count currently. 

add map for pirate
not in the player page. 




add 3 dice red yellow and G B Black
add section for books 
book page change possible only when its your turn 
book page change requirement need to be checked. 
play dev card only possible in your turn. 
pick drop /give cards any time. 



remove robber. 