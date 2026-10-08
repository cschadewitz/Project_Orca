"""Read one bounded JSON member without extracting any artifact-controlled path."""
import json
import stat
import sys
import zipfile

LIMIT = 4 * 1024 * 1024
with zipfile.ZipFile(sys.argv[1]) as archive:
    members = archive.infolist()
    if len(members) != 1:
        raise ValueError("unexpected_artifact_members")
    member = members[0]
    mode = member.external_attr >> 16
    if (member.filename != "evidence.json" or member.is_dir()
            or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG))
            or member.flag_bits & 1
            or member.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
            or not 0 < member.file_size <= LIMIT):
        raise ValueError("unsafe_artifact_member")
    with archive.open(member) as stream:
        raw = stream.read(LIMIT + 1)
    if len(raw) != member.file_size or len(raw) > LIMIT:
        raise ValueError("oversized_artifact_member")
    value = json.loads(raw.decode("utf-8"))
    sys.stdout.write(json.dumps(value))
