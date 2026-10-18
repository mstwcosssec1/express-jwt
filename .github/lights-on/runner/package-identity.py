"""Inspect distribution identity without extracting files or executing package code."""
import email.parser
import gzip
import io
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import xml.etree.ElementTree as ET
import zipfile

MAX_METADATA = 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024
MAX_MEMBERS = 20000

RUBY_IDENTITY_PARSER = r"""
require 'psych'
require 'json'

def check(condition)
  raise ArgumentError, 'Unsupported or ambiguous gem metadata' unless condition
end

scanner = Psych::ScalarScanner.new(Psych::ClassLoader::Restricted.new([], []))
string = lambda do |node|
  check(node.is_a?(Psych::Nodes::Scalar) && [nil, 'tag:yaml.org,2002:str'].include?(node.tag))
  value = node.quoted || node.tag ? node.value : scanner.tokenize(node.value)
  check(value.is_a?(String))
  value
end

stream = Psych.parse_stream(STDIN.read)
check(stream.children.length == 1)
root = stream.children.first.root
check(root.is_a?(Psych::Nodes::Mapping) && root.tag == '!ruby/object:Gem::Specification')
tags = %w[!ruby/object:Gem::Specification !ruby/object:Gem::Version
          !ruby/object:Gem::Requirement !ruby/object:Gem::Dependency !ruby/object:Gem::Platform
          !ruby/symbol tag:yaml.org,2002:map tag:yaml.org,2002:seq tag:yaml.org,2002:str
          tag:yaml.org,2002:int tag:yaml.org,2002:float tag:yaml.org,2002:bool
          tag:yaml.org,2002:null tag:yaml.org,2002:timestamp]
maps = {}
pending = [[root, 0]]
count = 0
until pending.empty?
  node, depth = pending.pop
  count += 1
  check(count <= 20000 && depth <= 64)
  check(!node.is_a?(Psych::Nodes::Alias) && (!node.respond_to?(:anchor) || node.anchor.nil?))
  check(node.tag.nil? || tags.include?(node.tag))
  if node.is_a?(Psych::Nodes::Mapping)
    fields = {}
    node.children.each_slice(2) do |key, value|
      name = string.call(key)
      check(name != '<<' && !fields.key?(name))
      fields[name] = value
    end
    maps[node] = fields
  end
  (node.children || []).each { |child| pending << [child, depth + 1] }
end
fields = maps.fetch(root)
version = fields.fetch('version')
check(version.is_a?(Psych::Nodes::Mapping) && version.tag == '!ruby/object:Gem::Version')
check(maps.fetch(version).keys == ['version'])
puts JSON.generate([string.call(fields.fetch('name')), string.call(maps.fetch(version).fetch('version'))])
"""


def require(condition, message):
    if not condition:
        raise ValueError(message)


def unique_json(text):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "Duplicate JSON metadata field")
            result[key] = value
        return result
    return json.loads(text, object_pairs_hook=pairs)


def bounded_text(file):
    require(file.is_file() and not file.is_symlink(), "Invalid metadata file")
    require(file.stat().st_size <= MAX_METADATA, "Metadata file too large")
    return file.read_text(encoding="utf-8")


def safe_member(name):
    clean = name.rstrip("/")
    require(isinstance(name, str) and clean and not name.startswith("/") and
            "\\" not in name and ":" not in name and not re.search(r"[\x00-\x1f]", name) and
            all(part not in ("", ".", "..") for part in clean.split("/")), "Unsafe archive member")


class LimitedReader:
    def __init__(self, source):
        self.source = source
        self.count = 0

    def read(self, size=-1):
        require(size >= 0, "Unbounded archive read")
        self.count += size
        require(self.count <= MAX_EXPANDED, "Expanded archive exceeds limit")
        return self.source.read(size)


def tar_metadata(file, predicate, compressed=True):
    found = {}
    total = 0
    names = set()
    source = gzip.open(file, "rb") if compressed else open(file, "rb")
    with source, tarfile.open(fileobj=LimitedReader(source), mode="r|") as archive:
        for count, member in enumerate(archive, 1):
            require(count <= MAX_MEMBERS, "Too many archive members")
            safe_member(member.name)
            require(member.name.rstrip("/") not in names, "Duplicate archive member")
            names.add(member.name.rstrip("/"))
            require(member.isfile() or member.isdir(), "Archive contains links or special files")
            total += member.size
            require(total <= MAX_EXPANDED, "Expanded archive exceeds limit")
            if predicate(member.name):
                require(member.isfile() and member.name not in found, "Duplicate or non-file metadata")
                require(member.size <= MAX_METADATA, "Package metadata exceeds limit")
                found[member.name] = archive.extractfile(member).read(MAX_METADATA + 1)
    return found


def zip_metadata(file, predicate):
    found = {}
    with zipfile.ZipFile(file) as archive:
        entries = archive.infolist()
        require(len(entries) <= MAX_MEMBERS, "Too many archive members")
        require(sum(entry.file_size for entry in entries) <= MAX_EXPANDED, "Expanded archive exceeds limit")
        names = set()
        for entry in entries:
            safe_member(entry.filename)
            require(entry.filename.rstrip("/") not in names, "Duplicate archive member")
            names.add(entry.filename.rstrip("/"))
            require(not entry.flag_bits & 1, "Encrypted package metadata is not supported")
            mode = entry.external_attr >> 16
            require(not stat.S_ISLNK(mode), "Archive contains a symlink")
            if predicate(entry.filename):
                require(entry.filename not in found and not entry.is_dir(), "Duplicate metadata entry")
                require(entry.file_size <= MAX_METADATA, "Package metadata exceeds limit")
                with archive.open(entry) as stream:
                    data = stream.read(MAX_METADATA + 1)
                    require(len(data) <= MAX_METADATA, "Metadata expansion exceeds limit")
                    found[entry.filename] = data
    return found


def one(items):
    require(len(items) == 1, "Expected exactly one package identity record")
    return next(iter(items.values())).decode("utf-8")


def xml_root(text):
    require("<!DOCTYPE" not in text.upper() and "<!ENTITY" not in text.upper(), "DTD/entity metadata is not permitted")
    return ET.fromstring(text)


def element_text(root, tag):
    values = [item.text for item in root.iter() if item.tag.split("}")[-1] == tag]
    require(len(values) == 1 and values[0], "Missing or ambiguous package identity field")
    return values[0].strip()


def name_key(name, ecosystem):
    require(isinstance(name, str) and name and re.fullmatch(r"(@[a-zA-Z0-9_.-]+/)?[a-zA-Z0-9_.-]+", name),
            "Invalid package name")
    if ecosystem == "pypi":
        return re.sub(r"[-_.]+", "-", name).lower()
    if ecosystem == "nuget":
        return name.lower()
    return name


def expected_names(request):
    ecosystem = request["ecosystem"]
    configured = request.get("package_names", {}).get(ecosystem)
    if configured is not None:
        require(isinstance(configured, list) and configured, "Expected package names must be a nonempty list")
        keys = [name_key(name, ecosystem) for name in configured]
        require(len(keys) == len(set(keys)), "Duplicate configured package names")
        return set(keys)
    root = pathlib.Path(request["repo_root"])
    names = []
    for target in request["targets"]:
        name = target["manifest"]
        require(pathlib.Path(name).name == name, "Expected top-level manifest")
        text = bounded_text(root / name)
        if ecosystem == "npm":
            names.append(unique_json(text)["name"])
        elif ecosystem == "pypi":
            require(name == "pyproject.toml", "Dynamic/setup.py projects require release.package_names.pypi")
            data = tomllib.loads(text)
            names.append(data.get("project", {}).get("name") or data.get("tool", {}).get("poetry", {}).get("name"))
        elif ecosystem == "crates":
            names.append(tomllib.loads(text)["package"]["name"])
        elif ecosystem == "nuget":
            xml = xml_root(text)
            values = [entry.text for entry in xml.iter() if entry.tag.split("}")[-1] == "PackageId"]
            require(len(values) <= 1, "Conditional package IDs require release.package_names.nuget")
            names.append(values[0] if values else pathlib.Path(name).stem)
        elif ecosystem == "rubygems":
            values = re.findall(r'^\s*\w+\.name\s*=\s*["\']([A-Za-z0-9_.-]+)["\']\s*$', text, re.M)
            require(len(values) == 1, "Dynamic gemspec names require release.package_names.rubygems")
            names.append(values[0])
    require(names, "No trusted release targets")
    keys = [name_key(name, ecosystem) for name in names]
    require(len(keys) == len(set(keys)), "Duplicate trusted package identity")
    return set(keys)


def artifact_identity(file, ecosystem):
    if ecosystem == "npm":
        data = unique_json(one(tar_metadata(file, lambda name: name == "package/package.json")))
        config = data.get("publishConfig", {})
        require(isinstance(config, dict) and set(config) <= {"registry", "access", "tag"},
                "Artifact publishConfig contains unsupported settings")
        require(config.get("registry", "https://registry.npmjs.org") in
                ("https://registry.npmjs.org", "https://registry.npmjs.org/"),
                "Artifact must not override the publishing registry")
        require(config.get("access", "public") in ("public", "restricted"), "Invalid publish access")
        require(isinstance(config.get("tag", "latest"), str) and
                re.fullmatch(r"[A-Za-z][A-Za-z0-9._-]{0,127}", config.get("tag", "latest")),
                "Unsupported publishing tag")
        return data["name"], data["version"]
    if ecosystem == "pypi":
        records = zip_metadata(file, lambda name: bool(re.fullmatch(r"[^/]+\.dist-info/METADATA", name))) if file.suffix == ".whl" else \
            tar_metadata(file, lambda name: bool(re.fullmatch(r"[^/]+/PKG-INFO", name)))
        message = email.parser.Parser().parsestr(one(records), headersonly=True)
        require(len(message.get_all("Name", [])) == 1 and len(message.get_all("Version", [])) == 1,
                "Missing or ambiguous Python package identity")
        return message["Name"], message["Version"]
    if ecosystem == "nuget":
        xml = xml_root(one(zip_metadata(file, lambda name: bool(re.fullmatch(r"[^/]+\.nuspec", name)))))
        metadata = [item for item in xml if item.tag.split("}")[-1] == "metadata"]
        require(len(metadata) == 1, "Invalid NuGet package metadata")
        return element_text(metadata[0], "id"), element_text(metadata[0], "version")
    if ecosystem == "crates":
        data = tomllib.loads(one(tar_metadata(file, lambda name: bool(re.fullmatch(r"[^/]+/Cargo.toml", name)))))
        return data["package"]["name"], data["package"]["version"]
    if ecosystem == "rubygems":
        records = tar_metadata(file, lambda name: name == "metadata.gz", compressed=False)
        require(len(records) == 1, "Missing gem metadata")
        with gzip.GzipFile(fileobj=io.BytesIO(records["metadata.gz"])) as stream:
            raw = stream.read(MAX_METADATA + 1)
        require(len(raw) <= MAX_METADATA, "Gem metadata expansion exceeds limit")
        # Parse syntax trees with the uploader's YAML parser, without loading Ruby
        # objects, evaluating a gemspec, or inheriting RUBYOPT/registry credentials.
        with tempfile.TemporaryDirectory(prefix="lights-on-gem-identity-") as home:
            env = {key: os.environ[key] for key in ("PATH", "SystemRoot") if key in os.environ}
            env.update(HOME=home, USERPROFILE=home)
            result = subprocess.run(["ruby", "--disable=gems", "-e", RUBY_IDENTITY_PARSER],
                                    input=raw.decode("utf-8"), text=True, capture_output=True,
                                    cwd=home, env=env, timeout=10, check=True)
        identity = unique_json(result.stdout)
        require(isinstance(identity, list) and len(identity) == 2 and
                all(isinstance(value, str) for value in identity), "Invalid RubyGems identity response")
        return identity[0], identity[1]
    raise ValueError("Unsupported package ecosystem")


def validate(request):
    ecosystem = request["ecosystem"]
    version = request["version"]
    require(isinstance(version, str) and re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version),
            "Invalid expected version")
    expected = expected_names(request)
    seen = set()
    distribution_names = set()
    results = []
    for name in request["files"]:
        file = pathlib.Path(name)
        if file.name == "crate-metadata.json":
            data = unique_json(bounded_text(file))
            require(name_key(data["name"], ecosystem) in expected and data["vers"] == version, "Crate API metadata identity mismatch")
            continue
        actual_name, actual_version = artifact_identity(file, ecosystem)
        key = name_key(actual_name, ecosystem)
        require(key in expected and actual_version == version, "Distribution name/version does not match the trusted release target")
        # Wheel filenames carry identity too; upload services use that identity
        # before/alongside METADATA. Bind both representations.
        if ecosystem == "pypi" and file.suffix == ".whl":
            parts = file.name[:-4].split("-")
            require(len(parts) in (5, 6) and name_key(parts[0], ecosystem) == key and parts[1] == version,
                    "Wheel filename and internal identity disagree")
        duplicate_key = (key, actual_version, file.suffix if ecosystem == "pypi" else "")
        if ecosystem != "pypi" or file.suffix != ".whl":
            require(duplicate_key not in distribution_names, "Duplicate distribution target")
        distribution_names.add(duplicate_key)
        seen.add(key)
        results.append({"file": file.name, "name": actual_name, "version": actual_version})
    require(seen == expected, "A trusted release target is missing from the artifact set")
    return results


if __name__ == "__main__":
    try:
        print(json.dumps(validate(json.load(sys.stdin))))
    except Exception as error:
        # Never echo arbitrary package metadata or credential-bearing subprocess arguments.
        print("Package identity verification failed: " + type(error).__name__, file=sys.stderr)
        sys.exit(1)
