"""Run official cases in order within a DS-1000 task or SciCode subproblem."""
import ast
import contextlib
import io
import json
import random
import sys
from pathlib import Path


class GraderError(Exception):
    """The trusted tests or their environment could not be prepared."""


def prepare_science_imports(problem):
    # Official test imports must work before any candidate is executed. Keep
    # helper code in the checker package, not in the agent's workspace.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from scicode.compare import cmp
    for source in [problem["required_dependencies"],
                   *(test for step in problem["sub_steps"] for test in step["test_cases"])]:
        tree = ast.parse(source)
        for statement in ast.walk(tree):
            if isinstance(statement, (ast.Import, ast.ImportFrom)):
                exec(compile(ast.Module(body=[statement], type_ignores=[]), "official_imports.py", "exec"), {})


def preflight_science(problems, data_file):
    import h5py
    with h5py.File(data_file, "r") as data:
        for problem in problems:
            prepare_science_imports(problem)
            for step in problem["sub_steps"]:
                for case in range(len(step["test_cases"])):
                    key = f'{step["step_number"]}/test{case + 1}'
                    if key not in data:
                        raise GraderError(f"Missing official numerical target: {key}")


class BoundedLog(io.TextIOBase):
    def __init__(self):
        self.text = ""

    def write(self, value):
        self.text = (self.text + str(value))[-2000:]
        return len(value)

    def flush(self):
        pass


def ds_check(problem, solution, checks, emit):
    tree = ast.parse(problem["code_context"])
    if checks == ["constraint"]:
        namespace = {}
        exec(compile(tree, "official_ds1000_test.py", "exec"), namespace)
        namespace["test_string"](solution)
        emit("constraint")
        return
    try:
        fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "test_execution")
        loops = [n for n in fn.body if isinstance(n, ast.For)]
        if len(loops) != 1:
            raise RuntimeError("Unsupported DS-1000 test loop")
        loop = loops[0]
        if not (isinstance(loop.iter, ast.Call) and isinstance(loop.iter.func, ast.Name)
                and loop.iter.func.id == "range" and len(loop.iter.args) == 1
                and isinstance(loop.iter.args[0], ast.Constant)):
            raise RuntimeError("Unsupported DS-1000 test loop")
        if checks != list(range(loop.iter.args[0].value)):
            raise RuntimeError("DS-1000 check count does not match the official loop")
        # Keep the original loop and its shared setup/RNG state. Catch each
        # iteration's failure only to report Camellia partial credit.
        callback = "__camellia_report_case"
        index_name = "__camellia_case_index"
        loop.body.insert(0, ast.parse(f"{index_name} = {callback}.index").body[0])
        wrapper = ast.parse(f"try:\n    pass\nexcept BaseException as __camellia_error:\n    {callback}({index_name}, __camellia_error)\nelse:\n    {callback}({index_name})").body[0]
        wrapper.body = loop.body
        loop.body = [wrapper]
    except Exception as exc:
        raise GraderError(f"Unsupported official DS-1000 test: {exc}") from exc
    namespace = {callback: emit}
    exec(compile(ast.fix_missing_locations(tree), "official_ds1000_test.py", "exec"), namespace)
    namespace["test_execution"](solution)


def science_check(problem, solution, checks, data_file, emit):
    # -I removes the script directory from sys.path. Add only this trusted
    # package directory to load the upstream numerical-target reader.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        from scicode_targets import process_hdf5_to_tuple
        prepare_science_imports(problem)
        step_id = checks[0][0]
        step = next(s for s in problem["sub_steps"] if s["step_number"] == step_id)
        targets = process_hdf5_to_tuple(step_id, len(step["test_cases"]), data_file)
        tests = [compile(source, "official_scicode_test.py", "exec") for source in step["test_cases"]]
        if checks != [[step_id, i] for i in range(len(tests))]:
            raise ValueError("SciCode checks must preserve the official subproblem order")
        namespace = {}
        exec(compile(problem["required_dependencies"], "official_dependencies.py", "exec"), namespace)
    except Exception as exc:
        raise GraderError(f"{type(exc).__name__}: {exc}") from exc
    exec(compile(solution, "solution.py", "exec"), namespace)
    for case, test in enumerate(tests):
        namespace["target"] = targets[case]
        try:
            exec(test, namespace)
        except BaseException as exc:
            emit([step_id, case], exc)
        else:
            emit([step_id, case])


def describe_error(exc):
    message = str(exc)[:1200]
    if isinstance(exc, AssertionError) and not message:
        message = "The official output or numerical comparison did not match"
    frames = []
    tb = exc.__traceback__
    while tb:
        filename = Path(tb.tb_frame.f_code.co_filename).name
        if filename in ("solution.py", "official_scicode_test.py", "official_ds1000_test.py"):
            frames.append(f"{filename}:{tb.tb_lineno}")
        tb = tb.tb_next
    return {"error": type(exc).__name__ + ": " + message,
            "kind": "assertion" if isinstance(exc, AssertionError) else "exception",
            "location": " -> ".join(frames[-4:])}


def main():
    payload = json.load(sys.stdin)
    log = BoundedLog()
    output = sys.stdout
    checks = payload.get("checks", ["preflight"])

    def emit(check, exc=None):
        result = {"check": check, "passed": exc is None,
                  "infrastructure": isinstance(exc, GraderError) or (exc is not None and payload.get("mode") == "preflight")}
        if exc is not None:
            result.update(describe_error(exc))
            if log.text:
                result["log"] = log.text
        output.write(json.dumps(result, ensure_ascii=True) + "\n")
        output.flush()
        log.text = ""
        emit.index += 1

    emit.index = 0
    with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
        try:
            random.seed(42)
            import numpy as np
            np.random.seed(42)
            if payload.get("mode") == "preflight":
                preflight_science(payload["problems"], payload["dataFile"])
                emit("preflight")
            elif payload["library"] == "ds1000":
                ds_check(payload["problem"], payload["solution"], checks, emit)
            elif payload["library"] == "scicode":
                science_check(payload["problem"], payload["solution"], checks, payload["dataFile"], emit)
            else:
                raise RuntimeError("Unknown question library")
        except BaseException as exc:
            for check in checks[emit.index:]:
                emit(check, exc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
