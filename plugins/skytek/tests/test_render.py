"""End-to-end checks for the create-sow scripts.

    uv run --with pytest pytest plugins/skytek/tests

Each script runs through `uv run`, as the skill runs it, so the tests need
only pytest; the scripts bring their own dependencies.
"""

import json
import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest

SKILL = Path(__file__).resolve().parent.parent / "skills" / "create-sow"
SCRIPTS = SKILL / "scripts"
SAMPLE = SKILL / "assets" / "sample.json"
TEMPLATE = SKILL / "assets" / "sow-template.docx"


def run(script, *args):
    return subprocess.run(
        ["uv", "run", "-q", str(SCRIPTS / script), *map(str, args)],
        capture_output=True,
        text=True,
        timeout=300,
    )


def render(out_dir, data=SAMPLE, *extra):
    return run("render_sow.py", "--data", data, "--out-dir", out_dir, *extra)


def docx_xml(path):
    with zipfile.ZipFile(path) as z:
        return "".join(
            z.read(n).decode() for n in z.namelist() if n.startswith("word/") and n.endswith(".xml")
        )


def test_template_matches_schema():
    result = run("render_sow.py", "--check-template")
    assert result.returncode == 0, result.stderr


def test_built_template_matches_schema(tmp_path):
    """The builder's output is the bundled template's source; it must pass the same check."""
    built = tmp_path / "built.docx"
    assert run("build_template.py", "--out", built).returncode == 0
    result = run("render_sow.py", "--check-template", "--template", built)
    assert result.returncode == 0, result.stderr


def test_renders_sample(tmp_path):
    result = render(tmp_path, SAMPLE, "--no-pdf")
    assert result.returncode == 0, result.stderr
    out = json.loads(result.stdout)
    docx = Path(out["docx"])
    assert docx.name == "SOW_acme-logistics-pte-ltd_fleet-tracking-platform-migration_2026-10-09_v1.docx"
    assert json.loads(Path(out["data"]).read_text()) == json.loads(SAMPLE.read_text())

    xml = docx_xml(docx)
    assert "{{" not in xml and "{%" not in xml
    assert "Acme Logistics Pte. Ltd." in xml
    assert "USD 66,000.00" in xml  # computed total
    assert "9 October 2026" in xml  # ISO date formatted
    assert "Week 18" in xml  # free-text dates pass through
    assert "peak season &amp; slow" in xml  # escaped, not corrupting the XML
    assert "<w:br/>" in xml  # line breaks in background kept


def test_never_overwrites(tmp_path):
    first = json.loads(render(tmp_path, SAMPLE, "--no-pdf").stdout)
    second = json.loads(render(tmp_path, first["data"], "--no-pdf").stdout)
    assert first["docx"].endswith("_v1.docx")
    assert second["docx"].endswith("_v2.docx")
    assert Path(first["docx"]).exists()


def test_optional_fields_fall_back(tmp_path):
    data = json.loads(SAMPLE.read_text())
    for key in ("out_of_scope", "roles", "assumptions", "governing_law", "client_signatory_name", "version"):
        data.pop(key)
    path = tmp_path / "minimal.json"
    path.write_text(json.dumps(data))
    result = render(tmp_path, path, "--no-pdf")
    assert result.returncode == 0, result.stderr
    xml = docx_xml(json.loads(result.stdout)["docx"])
    assert "No exclusions specified." in xml
    assert "No assumptions specified." in xml
    assert "governed by the laws" not in xml


def test_rejects_invalid_data(tmp_path):
    data = json.loads(SAMPLE.read_text())
    del data["client_name"]
    data["pricing_model"] = "bartering"
    path = tmp_path / "bad.json"
    path.write_text(json.dumps(data))
    result = render(tmp_path, path, "--no-pdf")
    assert result.returncode == 2
    assert "client_name" in result.stderr and "bartering" in result.stderr
    assert not list(tmp_path.glob("*.docx"))


def test_extract_docx_reads_tables(tmp_path):
    out = json.loads(render(tmp_path, SAMPLE, "--no-pdf").stdout)
    result = run("extract_docx.py", out["docx"])
    assert result.returncode == 0, result.stderr
    assert "# 4. Deliverables" in result.stdout
    assert "| 1 | Assessment report | Current state, risks, data inventory | 6 November 2026 |" in result.stdout
    assert "- Target architecture on AWS" in result.stdout


SOFFICE = shutil.which("soffice") or shutil.which("libreoffice") or (
    "/Applications/LibreOffice.app/Contents/MacOS/soffice"
    if Path("/Applications/LibreOffice.app").exists()
    else None
)


@pytest.mark.skipif(not SOFFICE, reason="LibreOffice not installed")
def test_converts_to_pdf(tmp_path):
    result = render(tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    pdf = Path(json.loads(result.stdout)["pdf"])
    assert pdf.read_bytes().startswith(b"%PDF")
