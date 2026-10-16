"""End-to-end checks for the create-sow scripts.

    uv run --with pytest pytest plugins/skytek/tests

Each script runs through `uv run`, as the skill runs it, so the tests need
only pytest; the scripts bring their own dependencies.
"""

import base64
import importlib.util
import json
import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest

# A real 4x4 PNG, so python-docx's image parser accepts it.
TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAE0lEQVR4nGPkqjjBAANMcBZeDgBAugFS3uh6PAAAAABJRU5ErkJggg=="
)

SKILL = Path(__file__).resolve().parent.parent / "skills" / "create-sow"
SCRIPTS = SKILL / "scripts"
SAMPLE = SKILL / "assets" / "sample.json"
TEMPLATE = SKILL / "assets" / "sow-template.docx"

# What the sample sources from the RFP or the user: the fields render_sow.py checks for it.
SAMPLE_PRICING_FIELDS = (
    "effort", "currency", "pricing_model", "payment_schedule", "payment_terms", "tax_treatment", "governing_law",
)


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


def sample_without_source(*fields):
    """The sample with these `_sources` entries removed."""
    data = json.loads(SAMPLE.read_text())
    for field in fields:
        del data["_sources"][field]
    return data


def package_sample(items=None, items_source="rfp"):
    """The sample as a package project: `package_items` replace `effort`.

    `effort` stays in `_sources`, as a stale entry. `items_source=None` leaves `package_items` unsourced.
    """
    data = json.loads(SAMPLE.read_text())
    data["project_type"] = "package"
    del data["effort"]
    data["package_items"] = items or [{"item": "Setup", "quantity": 1, "unit_price": 66000}]
    if items_source:
        data["_sources"]["package_items"] = items_source
    return data


def render_json(tmp_path, data):
    """Write `data` to a file in tmp_path and render it without the PDF."""
    path = tmp_path / "data.json"
    path.write_text(json.dumps(data))
    return render(tmp_path, path, "--no-pdf")


def _load_embed_fonts():
    """embed_fonts.py declares no dependencies, so it's safe to import directly
    rather than through `uv run` (unlike the scripts `run()` shells out to)."""
    spec = importlib.util.spec_from_file_location("embed_fonts", SCRIPTS / "embed_fonts.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_template_matches_schema():
    result = run("render_sow.py", "--check-template")
    assert result.returncode == 0, result.stderr


def test_built_template_matches_schema(tmp_path):
    """The builder's output is the bundled template's source; it must pass the same check."""
    built = tmp_path / "built.docx"
    assert run("build_template.py", "--out", built).returncode == 0
    result = run("render_sow.py", "--check-template", "--template", built)
    assert result.returncode == 0, result.stderr


def test_template_fonts_are_all_embeddable():
    """Every TWK font name the template asks for must have a FONT_FILES entry in
    embed_fonts.py, or it's silently skipped and Word/LibreOffice substitutes a
    fallback font (this is exactly how the body text once fell back to a serif
    font after a weight was renamed in build_template.py but not in FONT_FILES).

    Non-TWK names (e.g. Courier, Symbol) are Word's own defaults, not ours to
    embed, so only the "TWK ..." family names are checked.
    """
    embed_fonts = _load_embed_fonts()
    names = {n for n in embed_fonts.used_font_names(TEMPLATE) if n.startswith("TWK ")}
    assert names, "no TWK font names found in the template; is TEMPLATE stale?"
    missing = sorted(names - embed_fonts.FONT_FILES.keys())
    assert not missing, f"no FONT_FILES entry for: {missing}"


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
    assert "<w:br/>" in xml  # line breaks in executive_summary kept
    assert "3.2 Migration" in xml  # one numbered heading per phase
    assert "word/media/" in "".join(zipfile.ZipFile(docx).namelist())  # logo embedded


def test_never_overwrites(tmp_path):
    first = json.loads(render(tmp_path, SAMPLE, "--no-pdf").stdout)
    second = json.loads(render(tmp_path, first["data"], "--no-pdf").stdout)
    assert first["docx"].endswith("_v1.docx")
    assert second["docx"].endswith("_v2.docx")
    assert Path(first["docx"]).exists()


def test_optional_fields_fall_back(tmp_path):
    data = json.loads(SAMPLE.read_text())
    for key in (
        "out_of_scope", "non_functional_requirements", "architecture_overview",
        "architecture_components", "integrations", "assumptions", "risks", "client_roles",
        "msa_reference", "governing_law", "author",
        "client_signatory_name", "version",
    ):
        data.pop(key)
    path = tmp_path / "minimal.json"
    path.write_text(json.dumps(data))
    result = render(tmp_path, path, "--no-pdf")
    assert result.returncode == 0, result.stderr
    xml = docx_xml(json.loads(result.stdout)["docx"])
    assert "No exclusions specified." in xml
    assert "No non-functional requirements specified." in xml
    assert "Technical Design Document" in xml
    assert "No specific risks identified" in xml
    assert "confirmed at kick-off" in xml
    assert "single point of contact" in xml  # standard assumptions
    assert "supersedes any other agreement" in xml  # no MSA
    assert "governed by the laws" not in xml
    assert "Author" not in xml


def test_empty_lists_print_fallbacks(tmp_path):
    data = json.loads(SAMPLE.read_text())
    data["assumptions"] = []
    data["tax_treatment"] = "inclusive"
    path = tmp_path / "empty.json"
    path.write_text(json.dumps(data))
    result = render(tmp_path, path, "--no-pdf")
    assert result.returncode == 0, result.stderr
    xml = docx_xml(json.loads(result.stdout)["docx"])
    assert "No assumptions specified." in xml
    assert "single point of contact" not in xml
    assert "inclusive of any applicable sales tax" in xml


def test_effort_pricing(tmp_path):
    result = render(tmp_path, SAMPLE, "--no-pdf")
    assert result.returncode == 0, result.stderr
    xml = docx_xml(json.loads(result.stdout)["docx"])
    assert "USD 18,000.00" in xml  # 20 mandays x USD 900
    assert ">100<" in xml  # total mandays
    assert "Unit price" not in xml


def test_package_pricing(tmp_path):
    data = package_sample(
        [
            {"item": "Platform licence", "description": "Annual, per vehicle", "quantity": 1200, "unit_price": 40},
            {"item": "Setup", "quantity": 1, "unit_price": 18000},
        ]
    )
    path = tmp_path / "package.json"
    path.write_text(json.dumps(data))
    result = render(tmp_path, path, "--no-pdf")
    assert result.returncode == 0, result.stderr
    xml = docx_xml(json.loads(result.stdout)["docx"])
    assert "1,200" in xml and "USD 48,000.00" in xml
    assert "USD 66,000.00" in xml
    assert "Mandays" not in xml and "Day rate" not in xml


def test_pricing_must_match_project_type(tmp_path):
    data = json.loads(SAMPLE.read_text())
    data["project_type"] = "package"  # still carries effort, lacks package_items
    path = tmp_path / "mismatch.json"
    path.write_text(json.dumps(data))
    result = render(tmp_path, path, "--no-pdf")
    assert result.returncode == 2
    assert "package_items" in result.stderr


def test_discount_lines(tmp_path):
    data = json.loads(SAMPLE.read_text())
    data["fees"] = [{"item": "Vendor investment", "amount": -6000}]
    data["_sources"]["fees"] = "user"
    data["payment_schedule"][-1]["amount"] -= 6000
    path = tmp_path / "discount.json"
    path.write_text(json.dumps(data))
    result = render(tmp_path, path, "--no-pdf")
    assert result.returncode == 0, result.stderr
    xml = docx_xml(json.loads(result.stdout)["docx"])
    assert "Subtotal" in xml
    assert "(USD 6,000.00)" in xml
    assert "USD 60,000.00" in xml

    data["fees"] = [{"item": "Credit", "amount": -70000}]
    path.write_text(json.dumps(data))
    result = render(tmp_path, path, "--no-pdf")
    assert result.returncode == 2
    assert "total is negative" in result.stderr


def test_rejects_payment_schedule_mismatch(tmp_path):
    data = json.loads(SAMPLE.read_text())
    data["payment_schedule"][-1]["amount"] += 1000
    path = tmp_path / "mismatch_payment.json"
    path.write_text(json.dumps(data))
    result = render(tmp_path, path, "--no-pdf")
    assert result.returncode == 2
    assert "payment_schedule" in result.stderr
    assert "67,000.00" in result.stderr and "66,000.00" in result.stderr
    assert not list(tmp_path.glob("*.docx"))


def test_client_logo_placeholder_by_default(tmp_path):
    result = render(tmp_path, SAMPLE, "--no-pdf")
    assert result.returncode == 0, result.stderr
    xml = docx_xml(json.loads(result.stdout)["docx"])
    assert "Customer logo" in xml
    # Only the SkyTek logo and the watermark are embedded; no client logo.
    assert len(zipfile.ZipFile(json.loads(result.stdout)["docx"]).namelist()) > 0
    media = [n for n in zipfile.ZipFile(json.loads(result.stdout)["docx"]).namelist() if "media/" in n]
    assert len(media) == 2


def test_client_logo_embedded_when_given(tmp_path):
    logo_path = tmp_path / "client-logo.png"
    logo_path.write_bytes(TINY_PNG)
    data = json.loads(SAMPLE.read_text())
    data["client_logo_path"] = str(logo_path)
    path = tmp_path / "with_logo.json"
    path.write_text(json.dumps(data))
    result = render(tmp_path, path, "--no-pdf")
    assert result.returncode == 0, result.stderr
    docx = json.loads(result.stdout)["docx"]
    xml = docx_xml(docx)
    assert "Customer logo" not in xml
    media = [n for n in zipfile.ZipFile(docx).namelist() if "media/" in n]
    assert len(media) == 3  # SkyTek logo, watermark, client logo


def test_rejects_missing_client_logo(tmp_path):
    data = json.loads(SAMPLE.read_text())
    data["client_logo_path"] = str(tmp_path / "nope.png")
    path = tmp_path / "missing_logo.json"
    path.write_text(json.dumps(data))
    result = render(tmp_path, path, "--no-pdf")
    assert result.returncode == 2
    assert "client_logo_path" in result.stderr
    assert not list(tmp_path.glob("*.docx"))


def test_rejects_unreadable_client_logo(tmp_path):
    bad_path = tmp_path / "not-an-image.png"
    bad_path.write_bytes(b"not a png")
    data = json.loads(SAMPLE.read_text())
    data["client_logo_path"] = str(bad_path)
    path = tmp_path / "bad_logo.json"
    path.write_text(json.dumps(data))
    result = render(tmp_path, path, "--no-pdf")
    assert result.returncode == 2
    assert "client_logo_path" in result.stderr
    assert not list(tmp_path.glob("*.docx"))


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


@pytest.mark.parametrize(
    "field",
    ["vendor_address", "vendor_signatory_name", "vendor_signatory_title", "start_date", "end_date"],
)
def test_rejects_empty_required_text(tmp_path, field):
    data = json.loads(SAMPLE.read_text())
    data[field] = ""
    path = tmp_path / "empty_field.json"
    path.write_text(json.dumps(data))
    result = render(tmp_path, path, "--no-pdf")
    assert result.returncode == 2
    assert field in result.stderr
    assert not list(tmp_path.glob("*.docx"))


def test_tax_treatment_is_required(tmp_path):
    """No schema default: an omitted tax treatment must be asked, not assumed exclusive."""
    data = json.loads(SAMPLE.read_text())
    del data["tax_treatment"]
    path = tmp_path / "no_tax.json"
    path.write_text(json.dumps(data))
    result = render(tmp_path, path, "--no-pdf")
    assert result.returncode == 2
    assert "tax_treatment" in result.stderr
    assert not list(tmp_path.glob("*.docx"))


def test_tax_treatment_has_no_schema_default():
    schema = json.loads((SKILL / "assets" / "sow.schema.json").read_text())
    assert "default" not in schema["properties"]["tax_treatment"]


@pytest.mark.parametrize("field", ["sow_date", "start_date"])
def test_rejects_impossible_calendar_date(tmp_path, field):
    """Matches YYYY-MM-DD but is not a date: exit 2, not a traceback."""
    data = json.loads(SAMPLE.read_text())
    data[field] = "2026-13-45"
    path = tmp_path / "bad_date.json"
    path.write_text(json.dumps(data))
    result = render(tmp_path, path, "--no-pdf")
    assert result.returncode == 2
    assert "2026-13-45" in result.stderr and "Traceback" not in result.stderr
    assert not list(tmp_path.glob("*.docx"))


def test_unexpected_errors_exit_2(tmp_path):
    """A template that is not a Word file used to escape as a traceback."""
    bad_template = tmp_path / "not-a-template.docx"
    bad_template.write_text("not a zip")
    out = tmp_path / "out"
    result = render(out, SAMPLE, "--no-pdf", "--template", bad_template)
    assert result.returncode == 2
    assert "Traceback" not in result.stderr
    assert json.loads(result.stderr)["error"]
    assert not list(out.glob("*.docx"))


@pytest.mark.parametrize("field", SAMPLE_PRICING_FIELDS)
def test_rejects_unsourced_pricing(tmp_path, field):
    result = render_json(tmp_path, sample_without_source(field))
    assert result.returncode == 2
    assert f"_sources.{field}: pricing must come from the RFP or the user (got missing)" in result.stderr
    assert not list(tmp_path.glob("*.docx"))


@pytest.mark.parametrize("source", ["default", "inferred"])
def test_rejects_default_and_inferred_pricing(tmp_path, source):
    data = json.loads(SAMPLE.read_text())
    data["_sources"]["effort"] = source
    result = render_json(tmp_path, data)
    assert result.returncode == 2
    assert f"_sources.effort: pricing must come from the RFP or the user (got {source})" in result.stderr
    assert not list(tmp_path.glob("*.docx"))


def test_reports_every_unsourced_pricing_field(tmp_path):
    data = json.loads(SAMPLE.read_text())
    del data["_sources"]
    result = render_json(tmp_path, data)
    assert result.returncode == 2
    for field in SAMPLE_PRICING_FIELDS:
        assert f"_sources.{field}:" in result.stderr


def test_package_checks_package_items_not_effort(tmp_path):
    result = render_json(tmp_path, package_sample(items_source=None))  # effort stays sourced; package_items is not
    assert result.returncode == 2
    assert "_sources.package_items:" in result.stderr
    assert "_sources.effort:" not in result.stderr


def test_effort_not_checked_for_package(tmp_path):
    data = package_sample()
    del data["_sources"]["effort"]
    result = render_json(tmp_path, data)
    assert result.returncode == 0, result.stderr


def test_fees_need_source_when_set(tmp_path):
    data = json.loads(SAMPLE.read_text())
    data["fees"] = [{"item": "Hosting", "amount": 500}]
    data["payment_schedule"][-1]["amount"] += 500
    result = render_json(tmp_path, data)
    assert result.returncode == 2
    assert "_sources.fees:" in result.stderr
    data["_sources"]["fees"] = "user"
    assert render_json(tmp_path, data).returncode == 0


def test_empty_fees_need_no_source(tmp_path):
    data = json.loads(SAMPLE.read_text())
    data["fees"] = []
    result = render_json(tmp_path, data)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("value", ["", "   "])
def test_empty_governing_law_needs_no_source(tmp_path, value):
    data = sample_without_source("governing_law")
    data["governing_law"] = value
    result = render_json(tmp_path, data)
    assert result.returncode == 0, result.stderr


def test_extract_docx_reads_tables(tmp_path):
    out = json.loads(render(tmp_path, SAMPLE, "--no-pdf").stdout)
    result = run("extract_docx.py", out["docx"])
    assert result.returncode == 0, result.stderr
    assert "# 4. Deliverables" in result.stdout
    assert "| Discovery | Assessment report | Current state, risks, data inventory | Document |" in result.stdout
    assert "- Inventory current platform and data" in result.stdout


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
