import os

from flask import Response, render_template, request, send_from_directory
from dashboard import dashboard_tile

from ppp import ERROR_FILE, INPUT_FILE, OUTPUT_FILE, process_links


def configure_routes_ppp_tool(app):
    @app.route('/ppp_tool', methods=['GET', 'POST'])
    @dashboard_tile(section="tools", title="PPP Tool", description="Process source URLs into a playlist file.", icon="settings", order=10)
    def ppp_tool_page():
        result = ""
        download_link_available = False
        view_link_available = False

        if request.method == 'POST':
            beg_str = request.form.get('beg', '1')
            end_str = request.form.get('end', '0')

            try:
                beg = int(beg_str)
                end = int(end_str)
            except ValueError:
                result = "Error: 'Beg' and 'End' must be valid numbers."
                return render_template(
                    'ppp_tool/ppp_tool.html',
                    result=result,
                    download_link_available=download_link_available,
                    view_link_available=view_link_available
                )

            result = process_links(beg, end)
            if result.startswith("✅"):
                download_link_available = True
                view_link_available = True

        return render_template(
            'ppp_tool/ppp_tool.html',
            result=result,
            download_link_available=download_link_available,
            view_link_available=view_link_available,
            output_filename=OUTPUT_FILE
        )

    @app.route('/ppp_tool/input')
    def view_ppp_input():
        if os.path.exists(INPUT_FILE):
            try:
                with open(INPUT_FILE, 'r', encoding='utf-8') as f:
                    lines = f.readlines()

                formatted_content = []
                for i, line in enumerate(lines):
                    stripped_line = line.rstrip('\n')
                    formatted_content.append(f"{i + 1:04d}  {stripped_line}")
                return Response("\n".join(formatted_content), mimetype='text/plain')
            except Exception as e:
                return f"Error reading input file: {e}", 500
        return "Error: Input file `data/_input.txt` not found on the server.", 404

    @app.route('/ppp_tool/error')
    def view_ppp_error():
        if os.path.exists(ERROR_FILE):
            try:
                with open(ERROR_FILE, 'r', encoding='utf-8') as f:
                    content = f.read()
                return Response(content, mimetype='text/plain')
            except Exception as e:
                return f"Error reading output file: {e}", 500
        return "Error: Output file not found. Please process the URLs first.", 404

    @app.route('/ppp_tool/<filename>')
    def view_m3u_file(filename):
        if not filename.endswith('.m3u'):
            return "Invalid file type. Only .m3u files can be viewed.", 400
        full_path = filename

        if os.path.exists(full_path):
            try:
                with open(full_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                return Response(content, mimetype='text/plain')
            except Exception as e:
                return f"Error reading file {filename}: {e}", 500
        return f"File **{filename}** not found.", 404

    @app.route('/ppp_tool/download')
    def download_ppp_output():
        if os.path.exists(OUTPUT_FILE):
            return send_from_directory(os.getcwd(), OUTPUT_FILE, as_attachment=True)
        return "Error: Output file not found. Please process the URLs first.", 404

    # @app.route('/ppp_output')
    # def view_ppp_output():
    #     if os.path.exists(OUTPUT_FILE):
    #         try:
    #             with open(OUTPUT_FILE, 'r', encoding='utf-8') as f:
    #                 content = f.read()
    #             return Response(content, mimetype='text/plain')
    #         except Exception as e:
    #             return f"Error reading output file: {e}", 500
    #     return "Error: Output file not found. Please process the URLs first.", 404