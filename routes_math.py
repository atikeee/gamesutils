import json
import os
import re
import tempfile
import threading
import uuid

from flask import abort, redirect, render_template, request, session, url_for


MATH_ROOT = os.path.join(os.path.dirname(__file__), "data", "math")
PROGRESS_FILE = os.path.join(MATH_ROOT, "progress.json")
_progress_lock = threading.Lock()


def _read_json(path):
    with open(path, "r", encoding="utf-8") as content_file:
        return json.load(content_file)


def _safe_slug(value):
    return bool(value and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", value))


def _chapters():
    chapters = []
    if not os.path.isdir(MATH_ROOT):
        return chapters
    for chapter_slug in sorted(os.listdir(MATH_ROOT)):
        chapter_dir = os.path.join(MATH_ROOT, chapter_slug)
        index_path = os.path.join(chapter_dir, "chapter.json")
        if not os.path.isdir(chapter_dir) or not os.path.isfile(index_path):
            continue
        chapter = _read_json(index_path)
        chapter["slug"] = chapter_slug
        chapter["learn_pages"] = _content_files(os.path.join(chapter_dir, "learn"))
        chapter["tests"] = _content_files(os.path.join(chapter_dir, "test"))
        chapters.append(chapter)
    return chapters


def _content_files(directory):
    entries = []
    if not os.path.isdir(directory):
        return entries
    for filename in sorted(os.listdir(directory)):
        if not filename.endswith(".json"):
            continue
        content = _read_json(os.path.join(directory, filename))
        content["slug"] = os.path.splitext(filename)[0]
        entries.append(content)
    return entries


def _find_content(chapter_slug, folder, page_slug):
    if not _safe_slug(chapter_slug) or not _safe_slug(page_slug):
        abort(404)
    path = os.path.join(MATH_ROOT, chapter_slug, folder, page_slug + ".json")
    if not os.path.isfile(path):
        abort(404)
    content = _read_json(path)
    content["slug"] = page_slug
    return content


def _user_id():
    if "math_user_id" not in session:
        session["math_user_id"] = str(uuid.uuid4())
    return session["math_user_id"]


def _load_progress():
    try:
        return _read_json(PROGRESS_FILE)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_attempt(test_key, answers, score=None, completed=False):
    with _progress_lock:
        progress = _load_progress()
        user_progress = progress.setdefault(_user_id(), {})
        user_progress[test_key] = {
            "answers": answers,
            "score": score,
            "completed": completed,
        }
        _write_progress(progress)


def _write_progress(progress):
    os.makedirs(MATH_ROOT, exist_ok=True)
    fd, temporary_path = tempfile.mkstemp(dir=MATH_ROOT, suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output_file:
            json.dump(progress, output_file, indent=2)
        os.replace(temporary_path, PROGRESS_FILE)
    finally:
        if os.path.exists(temporary_path):
            os.unlink(temporary_path)


def _reset_attempt(test_key):
    with _progress_lock:
        progress = _load_progress()
        user_progress = progress.get(_user_id(), {})
        user_progress.pop(test_key, None)
        if not user_progress:
            progress.pop(_user_id(), None)
        _write_progress(progress)


def _current_attempt(test_key):
    return _load_progress().get(_user_id(), {}).get(
        test_key,
        {"answers": {}, "score": None, "completed": False},
    )


def _grade_test(test, answers):
    results = {}
    correct = 0
    total = 0
    manual = 0
    for question in test.get("questions", []):
        question_id = question["id"]
        question_type = question.get("type")
        answer = answers.get(question_id)
        expected = question.get("answer")
        if question_type == "draw":
            manual += 1
            results[question_id] = {"status": "manual"}
            continue
        total += 1
        expected_options = expected if question_type == "multi" else ([expected] if expected else [])
        selected = answer if question_type == "multi" else ([answer] if answer else [])
        is_correct = sorted(answer or []) == sorted(expected or []) if question_type == "multi" else answer == expected
        if is_correct:
            correct += 1
        if question_type in ("single", "multi"):
            expected_text = ", ".join(
                option["text"] for option in question.get("options", []) if option["id"] in expected_options
            )
        else:
            expected_text = str(expected or "")
        results[question_id] = {
            "status": "correct" if is_correct else "incorrect",
            "expected_options": expected_options,
            "selected": selected,
            "expected_text": expected_text,
        }
    return {"correct": correct, "total": total, "manual": manual}, results


def configure_routes_math(app):
    @app.route("/mathpractice", strict_slashes=False)
    def mathpractice():
        chapters = _chapters()
        progress = _load_progress().get(_user_id(), {})
        for chapter in chapters:
            for test in chapter["tests"]:
                test_key = "%s/%s" % (chapter["slug"], test["slug"])
                test["completed"] = bool(progress.get(test_key, {}).get("completed"))
        return render_template("math_index.html", mode="practice", chapters=chapters)

    @app.route("/mathlearning", strict_slashes=False)
    def mathlearning():
        return render_template("math_index.html", mode="learning", chapters=_chapters())

    @app.route("/mathlearning/<chapter_slug>/<page_slug>")
    def math_learning_page(chapter_slug, page_slug):
        page = _find_content(chapter_slug, "learn", page_slug)
        return render_template("math_lesson.html", page=page, chapter_slug=chapter_slug)

    @app.route("/mathpractice/<chapter_slug>/<test_slug>", methods=["GET", "POST"])
    def math_practice_test(chapter_slug, test_slug):
        test = _find_content(chapter_slug, "test", test_slug)
        test_key = "%s/%s" % (chapter_slug, test_slug)
        attempt = _current_attempt(test_key)
        if request.method == "POST":
            if request.form.get("action") == "reset":
                _reset_attempt(test_key)
                return redirect(url_for("math_practice_test", chapter_slug=chapter_slug, test_slug=test_slug))
            answers = {}
            for question in test.get("questions", []):
                field_name = "question_%s" % question["id"]
                values = request.form.getlist(field_name)
                answers[question["id"]] = values if question.get("type") == "multi" else (values[0] if values else "")
            completed = request.form.get("action") == "submit"
            score = None
            results = {}
            if completed and test.get("grading") == "auto":
                score, results = _grade_test(test, answers)
            _save_attempt(test_key, answers, score, completed)
            attempt = {"answers": answers, "score": score, "completed": completed}
        elif attempt.get("completed") and test.get("grading") == "auto":
            _, results = _grade_test(test, attempt.get("answers", {}))
        else:
            results = {}
        return render_template(
            "math_test.html",
            test=test,
            chapter_slug=chapter_slug,
            attempt=attempt,
            results=results,
        )
