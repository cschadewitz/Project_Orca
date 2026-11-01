"""Closed connected preparation composition; never a qualifying/accepting gate."""
import stat

from controlled_contract import require
from controlled_delivery_semantics import authenticate_connected_delivery, publication
from controlled_save_semantics import authenticate_connected_save
from controlled_semantics import decode, encoded, same_json
from controlled_v2_model import model

MUTATIONS = {'protected-temp': 17, 'control-record': 2, 'sidecar-temp': 2, 'credentials-temp': 2,
             'lease-temp': 1, 'state-directory': 3, 'resource': 1, 'resource-directory': 1}


def effect_inventory(replay, *, standing_v2=False):
    """Close finite surviving names and all mutable object histories after full replay.

    Counts describe this exact source, not an exemption for unexamined operations.
    Full Replay has already consumed every raw event, including outside windows.
    """
    model(standing_v2)
    mutations = {**MUTATIONS, 'protected-temp': 18 if standing_v2 else 17}
    base = replay.original['base']
    store = base + '/workspace/.orca'
    private = store + '/private-execution/'
    for family, count in mutations.items():
        require(sum(o.family == family for o in replay.objects) == count,
                'unexpected aggregate mutable object count: ' + family)
    for obj in replay.objects:
        if obj.family in {'lock-directory', 'lock-token', 'resource-directory', 'resource'}:
            require(obj.names == set(), 'aggregate residual lock/resource namespace')
    protected = [o for o in replay.objects if o.family == 'protected-temp']
    private_paths = {name for o in protected for name in o.names}
    required = {private + '.execution-key', private + 'controlled.inputs.json'}
    require(len(private_paths) == mutations['protected-temp'] and required <= private_paths and all(
            name.startswith(private) and (name in required or name.endswith('.payload.json')) for name in private_paths),
            'aggregate protected record namespace differs')
    for obj in protected:
        publication(replay, obj)
        require(len(obj.names) == 1 and obj.mode == (stat.S_IFREG | 0o600) and obj.writer_closed and obj.synced and
                obj.temporary_cleanup_completion == obj.durable_publication_completion,
                'aggregate incomplete protected publication history')
    key = replay.paths[private + '.execution-key']
    inputs = replay.paths[private + 'controlled.inputs.json']
    require(publication(replay, key)[1] < inputs.creation_entry and
            publication(replay, inputs)[1] < replay.resources[0].creation_entry,
            'aggregate input/key publication follows owned resource creation')
    decoded = decode('controlled.inputs.json', inputs.data, key.data)
    require(same_json(decoded, {'runId': 'controlled', 'workflowId': 'controlled-test', 'workflowVersion': '1',
                               'vars': {}, 'sensitiveNames': [], 'secrets': []}),
            'aggregate unexpected original execution inputs')
    original_paths = {p for p in replay.original['directories'] if p == base or p.startswith(base + '/')}
    original_paths |= {p for p, v in replay.original['immutable'].items() if p.startswith(base + '/') and
                       v['family'] != 'enrollment-witness'}
    expected = original_paths | private_paths | {store + '/private-execution', store + '/leases', store + '/runs',
        base + '/control/intent.json', base + '/control/enrolled.json', base + '/credentials.json',
        base + '/workspace/orca.permissions.json', store + '/leases/run%3Acontrolled.json', store + '/runs/controlled.jsonl'}
    actual = {p for p in replay.paths if p == base or p.startswith(base + '/')}
    require(actual == expected, 'aggregate unexpected/missing surviving private path')
    journal = replay.paths[store + '/runs/controlled.jsonl']
    require(journal.family == 'connected-journal' and journal.data == b''.join(
        (encoded(row) + '\n').encode() for row in replay.journal_records), 'aggregate journal bytes differ from append history')
    return {'record': 'closed-connected-effect-inventory', 'authority': 'none',
            'mutableCounts': mutations, 'protectedFiles': len(private_paths), 'journalRecords': 4}


def compose_connected(replay, *, standing_v2=False):
    """Caller first completes ConnectedKernelReplay.run on the original full trace."""
    delivery = authenticate_connected_delivery(replay, standing_v2=standing_v2)
    save = authenticate_connected_save(replay, standing_v2=standing_v2)
    effects = effect_inventory(replay, standing_v2=standing_v2)
    return {'record': 'connected-aggregate-preparation-only', 'authority': 'none',
            'delivery': delivery, 'save': save, 'effects': effects, 'semanticModel': 'standing-v2' if standing_v2 else 'legacy-v1',
            'acceptingToken': None, 'productionEligible': False,
            'qualification': 'unavailable-independent-aggregate-review-and-fresh-evidence-pending'}
