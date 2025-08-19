import os
import re
from html import escape

def parse_bookmark_file(input_file):
    with open(input_file, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    structure = {}
    current_topic = None
    current_subtopic = None

    for line in lines:
        stripped = line.rstrip('\n')
        if not stripped.strip():
            continue
        if stripped.strip().startswith('#'):
            continue
        indent_level = len(line) - len(line.lstrip(' '))
        if indent_level == 0:
            current_topic = stripped.strip()
            structure[current_topic] = {}
        elif indent_level == 4:
            current_subtopic = stripped.strip()
            structure[current_topic][current_subtopic] = []
        elif indent_level == 8:
            parts = re.split(r'[\t,]', stripped.strip(), maxsplit=1)
            if len(parts) == 2:
                link_text, url = parts
                structure[current_topic][current_subtopic].append((link_text.strip(), url.strip()))
    return structure

def generate_html(structure, output_file):
    html = []
    html.append("<!DOCTYPE html>")
    html.append("<html lang='en'>")
    html.append("<head>")
    html.append("<meta charset='UTF-8'>")
    html.append("<meta name='viewport' content='width=device-width, initial-scale=1.0'>")
    html.append("<title>All Bookmarks</title>")
    html.append("""
    <style>
        body { font-family: Arial, sans-serif; padding: 20px; }
        .topic, .subtopic { cursor: pointer; margin: 5px 0; font-weight: bold; }
        .subtopic-list, .link-list { display: none; margin-left: 20px; }
        .link-item { margin-left: 20px; }
        #searchResults { margin-top: 20px; }
    </style>
    <script>
        function toggleVisibility(id) {
            var el = document.getElementById(id);
            if (el.style.display === 'none') {
                el.style.display = 'block';
            } else {
                el.style.display = 'none';
            }
        }

        function searchLinks() {
            var input = document.getElementById('searchInput').value.toLowerCase();
            var results = document.getElementById('searchResults');
            results.innerHTML = '';
            if (input.length === 0) return;

            var links = document.querySelectorAll('.link-item');
            links.forEach(function(link) {
                var text = link.textContent.toLowerCase();
                var url = link.getAttribute('data-url').toLowerCase();
                var topic = link.getAttribute('data-topic').toLowerCase();
                var subtopic = link.getAttribute('data-subtopic').toLowerCase();
                if (text.includes(input) || url.includes(input) || topic.includes(input) || subtopic.includes(input)) {
                    var clone = link.cloneNode(true);
                    results.appendChild(clone);
                }
            });
        }
    </script>
    <link href="style.css" rel="stylesheet"/></head>
    """)
    html.append("</head>")
    html.append("<body>")
    html.append("<h1>Atiq's Bookmarks Collection</h1>")
    html.append("<input type='text' id='searchInput' onkeyup='searchLinks()' placeholder='Search links...' style='width: 100%; padding: 8px;'>")
    html.append("<div id='bookmarkContainer'>")

    topic_id = 0
    for topic, subtopics in structure.items():
        topic_div_id = f"topic_{topic_id}"
        html.append(f"<div class='topic' onclick=\"toggleVisibility('{topic_div_id}')\">{escape(topic)}</div>")
        html.append(f"<div class='subtopic-list' id='{topic_div_id}' style='display:none;'>")
        subtopic_id = 0
        for subtopic, links in subtopics.items():
            subtopic_div_id = f"{topic_div_id}_sub_{subtopic_id}"
            html.append(f"<div class='subtopic' onclick=\"toggleVisibility('{subtopic_div_id}')\">{escape(subtopic)}</div>")
            html.append(f"<div class='link-list' id='{subtopic_div_id}' style='display:none;'>")
            for text, url in links:
                html.append(f"<div class='link-item' data-topic='{escape(topic)}' data-subtopic='{escape(subtopic)}' data-url='{escape(url)}'>{escape(text)} - <a href='{escape(url)}' target='_blank'>{escape(url)}</a></div>")
            html.append("</div>")
            subtopic_id += 1
        html.append("</div>")
        topic_id += 1

    html.append("</div>")
    html.append("<h2>Search Results</h2>")
    html.append("<div id='searchResults'></div>")
    html.append("</body>")
    html.append("</html>")

    with open(output_file, 'w', encoding='utf-8') as f:
        f.write('\n'.join(html))

if __name__ == '__main__':
    input_file = 'bookmark_2_html.txt'
    output_file = 'templates/links.html'
    structure = parse_bookmark_file(input_file)
    generate_html(structure, output_file)
    print(f"HTML file generated: {output_file}")
