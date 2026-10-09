Added disabled Mac update drain coordination and durable closed replacement recovery
policy, retaining exact approval/target/token and preserving protected-state plus
matching-binary generations when newer writes prevent automatic rollback. Production
activation still requires native writer, recovery and signed lifecycle acceptance.
