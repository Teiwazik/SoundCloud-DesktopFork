import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module.js';
import { Session } from './auth/entities/session.entity.js';
import configuration from './config/configuration.js';
import { HealthController } from './health/health.controller.js';
import { ListeningHistory } from './history/entities/listening-history.entity.js';
import { HistoryModule } from './history/history.module.js';
import { LikesModule } from './likes/likes.module.js';
import { LocalLike } from './local-likes/entities/local-like.entity.js';
import { LocalLikesModule } from './local-likes/local-likes.module.js';
import { MeModule } from './me/me.module.js';
import { OAuthApp } from './oauth-apps/entities/oauth-app.entity.js';
import { OAuthAppsModule } from './oauth-apps/oauth-apps.module.js';
import { PlaylistsModule } from './playlists/playlists.module.js';
import { RepostsModule } from './reposts/reposts.module.js';
import { ResolveModule } from './resolve/resolve.module.js';
import { SoundcloudModule } from './soundcloud/soundcloud.module.js';
import { TracksModule } from './tracks/tracks.module.js';
import { UsersModule } from './users/users.module.js';
import { DataSource, type DataSourceOptions } from 'typeorm';

const DATABASE_ENTITIES = [Session, ListeningHistory, LocalLike, OAuthApp];

function createDatabaseOptions(config: ConfigService): DataSourceOptions {
  const driver = config.get<string>('database.driver') || 'postgres';

  if (driver === 'pg-mem') {
    return {
      type: 'postgres',
      database: config.get<string>('database.name') || 'soundcloud_desktop',
      entities: DATABASE_ENTITIES,
      synchronize: true,
      extra: {
        databaseDriver: driver,
      },
    };
  }

  return {
    type: 'postgres',
    host: config.get<string>('database.host'),
    port: config.get<number>('database.port'),
    username: config.get<string>('database.username'),
    password: config.get<string>('database.password'),
    database: config.get<string>('database.name'),
    entities: DATABASE_ENTITIES,
    synchronize: true,
    extra: {
      databaseDriver: driver,
    },
  };
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => createDatabaseOptions(config),
      dataSourceFactory: async (options) => {
        if (!options) {
          throw new Error('Database options are required');
        }

        if (options.extra?.databaseDriver === 'pg-mem') {
          const { DataType, newDb } = await import('pg-mem');
          const db = newDb({
            autoCreateForeignKeyIndices: true,
          });
          const databaseName =
            typeof options.database === 'string' && options.database.length > 0
              ? options.database
              : 'soundcloud_desktop';

          db.public.registerFunction({
            name: 'version',
            returns: DataType.text,
            implementation: () => 'PostgreSQL 17.0 (pg-mem)',
          });
          db.public.registerFunction({
            name: 'current_database',
            returns: DataType.text,
            implementation: () => databaseName,
          });
          db.public.registerFunction({
            name: 'current_schema',
            returns: DataType.text,
            implementation: () => 'public',
          });
          db.public.registerFunction({
            name: 'obj_description',
            args: [DataType.integer, DataType.text],
            returns: DataType.text,
            implementation: () => null,
          });
          db.public.registerFunction({
            name: 'col_description',
            args: [DataType.integer, DataType.integer],
            returns: DataType.text,
            implementation: () => null,
          });
          db.public.registerFunction({
            name: 'uuid_generate_v4',
            returns: DataType.uuid,
            implementation: () => randomUUID(),
          });
          const dataSource = db.adapters.createTypeormDataSource(options);
          return dataSource.initialize();
        }

        return new DataSource(options).initialize();
      },
    }),
    OAuthAppsModule,
    AuthModule,
    SoundcloudModule,
    MeModule,
    TracksModule,
    PlaylistsModule,
    UsersModule,
    LikesModule,
    RepostsModule,
    ResolveModule,
    HistoryModule,
    LocalLikesModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
