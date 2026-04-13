"""Thin wrapper around the auto-generated PcmRuntime Connect-RPC client.

Exposes a simple keyword-argument API for the LLM agent while delegating
all transport to the generated stubs.
"""

import json
import os

from bitgn.vm.pcm_connect import PcmRuntimeClientSync
from bitgn.vm.pcm_pb2 import (
    AnswerRequest,
    ContextRequest,
    DeleteRequest,
    FindRequest,
    ListRequest,
    MkDirRequest,
    MoveRequest,
    Outcome,
    ReadRequest,
    SearchRequest,
    TreeRequest,
    WriteRequest,
)
from google.protobuf.json_format import MessageToDict

_KIND_MAP = {"all": 0, "files": 1, "dirs": 2}

_OUTCOME_MAP = {
    "OUTCOME_OK": Outcome.OUTCOME_OK,
    "OUTCOME_DENIED_SECURITY": Outcome.OUTCOME_DENIED_SECURITY,
    "OUTCOME_NONE_CLARIFICATION": Outcome.OUTCOME_NONE_CLARIFICATION,
    "OUTCOME_NONE_UNSUPPORTED": Outcome.OUTCOME_NONE_UNSUPPORTED,
    "OUTCOME_ERR_INTERNAL": Outcome.OUTCOME_ERR_INTERNAL,
}


def _to_dict(msg):
    return MessageToDict(msg)


class Workspace:
    def __init__(self, harness_url=None, answer_path=None):
        url = harness_url or os.environ.get("RUNTIME_HARNESS_URL")
        if not url:
            raise ValueError("RUNTIME_HARNESS_URL is not set")
        self._answer_path = answer_path or os.environ.get("AGENT_ANSWER_PATH")
        if not self._answer_path:
            raise ValueError("AGENT_ANSWER_PATH is not set")
        self._vm = PcmRuntimeClientSync(url)
        self._tracking_path = os.environ.get("AGENT_TRACKING_PATH")
        self._tracking = self._load_tracking()

    def _load_tracking(self):
        if not self._tracking_path:
            return {"read_paths": [], "write_paths": [], "delete_paths": []}
        try:
            with open(self._tracking_path) as f:
                data = json.load(f)
                return {
                    "read_paths": data.get("read_paths", []),
                    "write_paths": data.get("write_paths", []),
                    "delete_paths": data.get("delete_paths", []),
                }
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return {"read_paths": [], "write_paths": [], "delete_paths": []}

    def _save_tracking(self):
        if not self._tracking_path:
            return
        try:
            with open(self._tracking_path, "w") as f:
                json.dump(self._tracking, f)
        except OSError:
            pass

    def _track_read(self, path):
        if path not in self._tracking["read_paths"]:
            self._tracking["read_paths"].append(path)
            self._save_tracking()

    def _track_write(self, path):
        if path not in self._tracking["write_paths"]:
            self._tracking["write_paths"].append(path)
            self._save_tracking()

    def _track_delete(self, path):
        if path not in self._tracking["delete_paths"]:
            self._tracking["delete_paths"].append(path)
            self._save_tracking()

    def tree(self, root="", level=0):
        return _to_dict(self._vm.tree(TreeRequest(root=root, level=level)))

    def find(self, root="/", name="", kind="all", limit=10):
        return _to_dict(
            self._vm.find(
                FindRequest(root=root, name=name, type=_KIND_MAP[kind], limit=limit)
            )
        )

    def search(self, root="/", pattern="", limit=10):
        return _to_dict(
            self._vm.search(SearchRequest(root=root, pattern=pattern, limit=limit))
        )

    def list(self, path="/"):
        return _to_dict(self._vm.list(ListRequest(name=path)))

    def read(self, path, number=False, start_line=0, end_line=0):
        self._track_read(path)
        return _to_dict(
            self._vm.read(
                ReadRequest(
                    path=path, number=number, start_line=start_line, end_line=end_line
                )
            )
        )

    def write(self, path, content, start_line=0, end_line=0):
        self._vm.write(
            WriteRequest(
                path=path, content=content, start_line=start_line, end_line=end_line
            )
        )
        self._track_write(path)

    def delete(self, path):
        self._vm.delete(DeleteRequest(path=path))
        self._track_delete(path)

    def mkdir(self, path):
        self._vm.mk_dir(MkDirRequest(path=path))

    def move(self, from_name, to_name):
        self._vm.move(MoveRequest(from_name=from_name, to_name=to_name))
        self._track_delete(from_name)
        self._track_write(to_name)

    def context(self):
        return _to_dict(self._vm.context(ContextRequest()))

    def answer(self, scratchpad, verify):
        if not callable(verify):
            _msg = (
                "SUBMISSION BLOCKED: verify must be a callable function.\n"
                "Define def verify(sp): ... and pass it to ws.answer(scratchpad, verify)."
            )
            print(_msg)
            raise ValueError(_msg)

        # Run verification — must return truthy
        try:
            _result = verify(scratchpad)
        except Exception as _exc:
            _msg = (
                f"VERIFICATION FUNCTION ERROR: {_exc}\n"
                f"Fix your verify function and retry."
            )
            print(_msg)
            raise ValueError(_msg)

        if not _result:
            _msg = (
                "VERIFICATION FAILED: verify(scratchpad) returned False.\n"
                "Fix scratchpad and retry ws.answer()."
            )
            print(_msg)
            raise ValueError(_msg)

        # Extract fields from scratchpad
        message = scratchpad.get("answer", "")
        outcome = scratchpad.get("outcome", "OUTCOME_OK")
        refs = scratchpad.get("refs", [])

        # Strip leading / from answer paths — evaluator expects relative paths
        if isinstance(message, str) and message.strip():
            _lines = message.split("\n")
            if all(l.strip().startswith("/") for l in _lines if l.strip()):
                message = "\n".join(l.strip().lstrip("/") for l in _lines)
                scratchpad["answer"] = message

        # Outcome string validation
        if outcome not in _OUTCOME_MAP:
            _msg = (
                f"SUBMISSION BLOCKED: unknown outcome '{outcome}'. "
                f"Valid: {', '.join(_OUTCOME_MAP.keys())}"
            )
            print(_msg)
            raise ValueError(_msg)

        # Required fields
        _required = ["answer", "outcome"]
        if outcome != "OUTCOME_OK":
            _required.append("refs")
        _missing = [k for k in _required if k not in scratchpad]
        if _missing:
            _fields = ", ".join(f'scratchpad["{k}"]' for k in _missing)
            _msg = (
                f"SUBMISSION BLOCKED: scratchpad missing fields: "
                f"{', '.join(_missing)}.\n"
                f"Fix: populate {_fields}, then call ws.answer() again."
            )
            print(_msg)
            raise ValueError(_msg)

        # Refs completeness warning
        if self._tracking_path:
            _refs_set = set(refs or [])
            _all_read = set(self._tracking.get("read_paths", []))
            _missing_refs = _all_read - _refs_set
            if _missing_refs:
                _sample = sorted(_missing_refs)[:5]
                print(
                    f"WARNING: {len(_missing_refs)} read path(s) not in refs: "
                    f"{_sample}"
                )

        # Writes on blocked outcome warning
        if outcome != "OUTCOME_OK" and self._tracking_path:
            _writes = self._tracking.get("write_paths", [])
            if _writes:
                print(
                    f"WARNING: outcome is {outcome} but "
                    f"{len(_writes)} write(s) were made: {_writes[:5]}. "
                    f"Blocked outcomes should produce zero file writes."
                )

        self._vm.answer(
            AnswerRequest(
                message=message,
                outcome=_OUTCOME_MAP[outcome],
                refs=refs or [],
            )
        )

        with open(self._answer_path, "w") as f:
            json.dump(
                {"message": message, "outcome": outcome, "refs": refs or []},
                f,
            )
            f.flush()
            os.fsync(f.fileno())
