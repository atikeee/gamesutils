hint_log = []
buzzer_entries = []
name_locks = {}
codenames_spy_password='xxx'
codenames_words = []
codenames_colors = []
current_game = {
    'words': [],
    'colors': [],
    'revealed': set(),  # store indices of revealed words
    'team': 'red',
}

pf_players = []
pf_cards = {} # empty list for each player. 
pf_deck = []
pf_timer = [5,5,5] #seconds for different levels. 
pf_level = 1
pf_player_idx = 0
pf_word_idx = 0
pf_score = {} # list of 3 for each player. 
pf_cur_savedwords=[]
pf_cur_skippedwords=[]
