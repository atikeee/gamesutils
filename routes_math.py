from flask import render_template


MATH_PAGES = {
    "mathpractice": {
        "title": "Math Practice",
        "description": "",
        "sections": [],
    },
    "mathlearning": {
        "title": "Math Learning",
        "description": "",
        "sections": [],
    },
}


def configure_routes_math(app):
    @app.route("/mathpractice")
    def mathpractice():
        return render_template("math_content.html", page=MATH_PAGES["mathpractice"])

    @app.route("/mathlearning")
    def mathlearning():
        return render_template("math_content.html", page=MATH_PAGES["mathlearning"])