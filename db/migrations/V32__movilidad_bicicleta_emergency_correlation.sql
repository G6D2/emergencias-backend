-- Movilidad usa IDs externos no UUID (EMG-...) para correlacionar el pedido
-- con los eventos de Emergencias. Mantener el UUID local en emergencies.id.
ALTER TABLE emergencies
    ALTER COLUMN correlation_id TYPE TEXT USING correlation_id::TEXT,
    DROP CONSTRAINT emergencies_causa_tipo_check;

ALTER TABLE emergencies
    ADD CONSTRAINT emergencies_causa_tipo_check
    CHECK (
        causa_tipo IS NULL
        OR causa_tipo IN (
            'EVENTO_CLIMATICO',
            'RECLAMO',
            'INCIDENTE_VIAL',
            'EVENTO_PUBLICO',
            'RESERVA',
            'MOVILIDAD_BICICLETA'
        )
    );

CREATE UNIQUE INDEX uq_emergencies_movilidad_bicicleta_causa
    ON emergencies (causa_id)
    WHERE causa_tipo = 'MOVILIDAD_BICICLETA';
